'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Clock, Download,
  Pause, Play, Plus, RefreshCw, Trash2, Pencil, Wifi, Database, Globe, Cpu,
  FileArchive, ListChecks, Loader2, Radio,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PageHeader, SectionCard, SectionHeading, StatusBadge, EmptyState, LoadingState,
  StatCard, fmtCompact,
} from '@/components/design-system';
import { useScheduleEvents, type ScheduleEvent } from '@/hooks/use-schedule-events';
import { useSettingValue } from '@/lib/settings/store';

/* ------------------------------- Types ------------------------------- */

type Section = { ok: boolean; reason?: string; data: any };

interface ScheduleJob {
  _id: string;
  name: string;
  enabled: boolean;
  symbols?: string[];
  symbolMode?: string;
  fields?: string[];
  formats?: string[];
  schedule?: { type?: string; time?: string; days?: number[]; timezone?: string };
  dateRange?: { type?: string; days?: number; startDate?: string; endDate?: string };
  destination?: string;
  nextRun?: string | null;
  lastRun?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  failCount?: number;
  runCount?: number;
  retry_count?: number;
  firstAttemptAt?: string | null;
  lastAttemptAt?: string | null;
  nextRetryAt?: string | null;
  failure_reason?: string | null;
  lastFile?: string | null;
  lastFileSize?: number | null;
  historyId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  timezone?: string;
}

interface ScheduleRun {
  _id: string;
  scheduleId: string;
  scheduleName?: string;
  trigger?: string;
  runAt?: string;
  status?: string;
  error?: string;
  stocks?: string[];
  symbolCount?: number;
  historyId?: string;
  fileId?: string;
  fileName?: string;
  fileSizeBytes?: number;
  recordCount?: number;
  durationMs?: number;
  deliveredTo?: string;
}

/* ----------------------------- Helpers ------------------------------- */

const fmtBytes = (b: number | null | undefined): string => {
  if (b == null || !Number.isFinite(b) || b <= 0) return '—';
  if (b >= 1099511627776) return `${(b / 1099511627776).toFixed(2)} TB`;
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
};

const ist = (v?: string | null): string => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: '2-digit', year: 'numeric' });
};

const istDate = (v?: string | null): string => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
};

const isTodayIst = (v?: string | null): boolean => {
  if (!v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const today = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
  const that = d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
  return that === today;
};

/* -------------------- Live countdown / event ui -------------------- */

function Countdown({ to, recording = false }: { to: string | null | undefined; recording?: boolean }) {
  const target = useMemo(() => (to ? new Date(to).getTime() : null), [to]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (target == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (target == null) return <span className="tabular-nums">—</span>;
  const diff = target - now;
  if (diff <= 0) return <span className="tabular-nums text-success">{recording ? 'Running…' : 'Due now'}</span>;
  const s = Math.floor(diff / 1000);
  const dd = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = dd > 0 ? `${dd}d ${pad(hh)}h` : `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return <span className="tabular-nums">{label}</span>;
}

function liveStatusMeta(status?: string): { tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral'; label: string } {
  switch (status) {
    case 'running': return { tone: 'info', label: 'Running…' };
    case 'due': return { tone: 'warning', label: 'Due' };
    case 'waiting': return { tone: 'warning', label: 'Waiting' };
    case 'retrying': return { tone: 'warning', label: 'Retrying' };
    case 'missed': return { tone: 'danger', label: 'Missed' };
    case 'skipped': return { tone: 'warning', label: 'Skipped' };
    case 'success': return { tone: 'success', label: 'Completed' };
    case 'failed': return { tone: 'danger', label: 'Failed' };
    default: return { tone: 'neutral', label: 'Active' };
  }
}

const EVENT_LABELS: Record<string, string> = {
  SCHEDULE_DUE: 'Schedule became due',
  SCHEDULE_RUNNING: 'Execution started',
  SCHEDULE_EXPORT_STARTED: 'Export started',
  SCHEDULE_COMPLETED: 'Export completed',
  SCHEDULE_FAILED: 'Execution failed',
  SCHEDULE_WAITING: 'Waiting on dependency',
  SCHEDULE_RETRYING: 'Retrying',
  SCHEDULE_SKIPPED: 'Skipped',
  SCHEDULE_MISSED: 'Missed run recovered',
  SCHEDULE_CREATED: 'Schedule created',
  SCHEDULE_UPDATED: 'Schedule updated',
  SCHEDULE_DELETED: 'Schedule deleted',
  PACKAGE_READY: 'Package ready',
  PACKAGE_DL_QUEUED: 'Download queued',
  PACKAGE_DL_STARTED: 'Download started',
  PACKAGE_DL_COMPLETED: 'Download completed',
  PACKAGE_DL_FAILED: 'Download failed',
};

function eventTone(event: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (event === 'SCHEDULE_FAILED' || event === 'PACKAGE_DL_FAILED') return 'danger';
  if (event === 'SCHEDULE_COMPLETED' || event === 'PACKAGE_READY' || event === 'PACKAGE_DL_COMPLETED') return 'success';
  if (event === 'SCHEDULE_WAITING' || event === 'SCHEDULE_RETRYING' || event === 'SCHEDULE_SKIPPED' || event === 'SCHEDULE_MISSED') return 'warning';
  if (event === 'SCHEDULE_RUNNING' || event === 'SCHEDULE_DUE' || event === 'SCHEDULE_EXPORT_STARTED' || event === 'PACKAGE_DL_STARTED' || event === 'PACKAGE_DL_QUEUED') return 'info';
  return 'neutral';
}

function eventTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function summary(event: ScheduleEvent): string {
  const prefix = eventTime(event.ts);
  const action = ({
    PACKAGE_READY: 'Package ready',
    SCHEDULE_COMPLETED: 'Completed',
    SCHEDULE_FAILED: 'Failed',
    SCHEDULE_WAITING: 'Waiting',
  } as Record<string, string>)[event.event] ?? event.event;
  let detail = (event.scheduleName ?? '').trim();
  if (!detail) detail = '';
  if (event.event === 'PACKAGE_READY') detail = String(event.filename ?? '');
  if (event.event === 'SCHEDULE_COMPLETED') detail = `${fmtCompact(event.recordCount as number)} records`;
  if (event.event === 'SCHEDULE_FAILED') detail = String(event.error ?? '');
  if (event.event === 'SCHEDULE_WAITING') detail = String(event.reason ?? '');
  return [prefix, action, detail].filter(Boolean).join(' — ');
}

function statusMeta(status?: string | null, enabled = true) {
  const s = (status || '').toUpperCase();
  if (!enabled) return { tone: 'neutral' as const, label: 'Paused' };
  if (['SUCCESS', 'COMPLETED', 'OK'].includes(s)) return { tone: 'success' as const, label: 'Completed' };
  if (['FAILED', 'ERROR'].includes(s)) return { tone: 'danger' as const, label: 'Failed' };
  if (['WAITING_FOR_DEPENDENCY', 'WAITING'].includes(s)) return { tone: 'warning' as const, label: 'Waiting' };
  if (['RETRYING', 'RUNNING'].includes(s)) return { tone: 'info' as const, label: s === 'RETRYING' ? 'Retrying' : 'Running' };
  if (s === 'SKIPPED') return { tone: 'warning' as const, label: 'Skipped' };
  if (s === 'PENDING_RETRY') return { tone: 'warning' as const, label: 'Pending retry' };
  return { tone: 'neutral' as const, label: 'Active' };
}

function InlineError({ reason, onRetry }: { reason?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-xs">
      <div className="flex items-center gap-2">
        <StatusBadge status="danger" label="Unavailable" />
        <span className="text-foreground font-medium">Section data unavailable</span>
      </div>
      {reason && <p className="text-muted-foreground mt-1.5">Reason: {reason}</p>}
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px] gap-1" onClick={onRetry}>
          <RefreshCw className="h-3 w-3" /> Retry
        </Button>
      )}
    </div>
  );
}

function Field({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right tabular-nums ${strong ? 'font-semibold text-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function scheduleRuleText(job: ScheduleJob): string {
  const s = job.schedule ?? {};
  const tz = s.timezone || job.timezone || 'Asia/Kolkata';
  const type = s.type || 'daily';
  if (type === 'weekly') return `Weekly · ${(s.days ?? []).map((d) => DAYS[d] ?? '').filter(Boolean).join(', ')}`;
  if (type === 'weekdays') return 'Weekdays (Mon–Fri)';
  return 'Every day';
}

function scheduleTimeText(job: ScheduleJob): string {
  const t = (job.schedule ?? {}).time || '09:00';
  const tz = (job.schedule ?? {}).timezone || job.timezone || 'Asia/Kolkata';
  const tzShort = tz.endsWith('Kolkata') ? 'IST' : tz;
  return `${t} ${tzShort}`;
}

/* ------------------------------- Page -------------------------------- */

export default function Phase2SchedulesPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detailOpen, setDetailOpen] = useState<Set<string>>(new Set());
  const [runningSet, setRunningSet] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState<Record<string, 'running' | 'done' | 'failed'>>({});
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const mountedRef = useRef(true);
  const dataRef = useRef<any>(null);
  dataRef.current = data;

  // Read settings once at component level (before useCallback captures them).
  // useSettingValue cannot be called inside useCallback([]) deps.
  const autoDownloadWhenOnline = useSettingValue('ds_auto_download_when_online');
  const deviceId = useSettingValue('ds_device_id') || 'default-device';

  // Live scheduler event stream.
  const { connected, recentEvents, scheduleStates } = useScheduleEvents();

  // Auto-download the generated package the moment PACKAGE_READY fires, and
  // mark the device download state machine on the backend.
  // Respects ds_auto_download_when_online setting and includes deviceId.
  const handlePackageReady = useCallback((ev: ScheduleEvent) => {
    const packageId = String(ev.packageId ?? '');
    const historyId = String(ev.historyId ?? '');
    const filename = String(ev.filename ?? '');
    const jobName = String(ev.scheduleName ?? 'package');
    if (!packageId || !historyId) return;

    if (!autoDownloadWhenOnline) {
      // Still mark as downloaded on backend but don't auto-trigger browser download
      fetch(`/api/phase2/schedules/packages/${encodeURIComponent(packageId)}/download`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', deviceId }),
      }).catch(() => {});
      return;
    }

    // 1) Mark DOWNLOAD_QUEUED then STARTED on the backend.
    fetch(`/api/phase2/schedules/packages/${encodeURIComponent(packageId)}/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', deviceId }),
    }).catch(() => {});

    // 2) Trigger the browser download through the real file proxy.
    const a = document.createElement('a');
    a.href = `/api/phase2/download-history/${encodeURIComponent(historyId)}/file`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setDownloading((prev) => ({ ...prev, [packageId]: 'running' }));
    setAutoLog((prev) => [`${eventTime(ev.ts)} ${jobName} — downloaded ${filename || historyId}`, ...prev].slice(0, 30));
    // Loose optimistic completion.
    setTimeout(() => setDownloading((prev) => ({ ...prev, [packageId]: 'done' })), 4000);
  }, []);

  // Subscribe to newly-readied packages.
  const handledRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!connected) return;
    for (const ev of recentEvents) {
      if (ev.event === 'PACKAGE_READY') {
        const key = String(ev.eventId ?? '');
        if (key && !handledRef.current.has(key)) {
          handledRef.current.add(key);
          handlePackageReady(ev);
        }
      }
    }
  }, [recentEvents, connected, handlePackageReady]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/phase2/schedules?t=${Date.now()}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const d = await res.json();
      if (!mountedRef.current) return;
      setData(d);
      setLoadError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      const reason = e instanceof Error ? e.message : 'Failed to load schedules';
      if (dataRef.current) setLoadError(reason);
      else setLoadError(reason);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);
  // Gentle 30s auto-refresh keeps the page live; failures never blank it.
  useEffect(() => {
    const id = setInterval(() => { fetchData(); }, 30000);
    return () => clearInterval(id);
  }, [fetchData]);

  const retry = () => { setRefreshKey((k) => k + 1); };
  const toggle = (id: string) => {
    setDetailOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const jobs: ScheduleJob[] = useMemo(() => data?.jobs ?? [], [data]);
  const runsBySchedule: Record<string, ScheduleRun[]> = useMemo(() => data?.runs?.bySchedule ?? {}, [data]);
  const health = data?.health && data.health.ok !== false ? data.health : null;
  const deps = health?.dependencies?.checks ?? [];
  const market = health?.market ?? null;

  // Derived summary values (all real).
  const activeCount = jobs.filter((j) => j.enabled).length;
  const waitingCount = jobs.filter((j) => {
    const s = (j.lastStatus || '').toUpperCase();
    return j.enabled && (s === 'WAITING_FOR_DEPENDENCY' || s === 'WAITING' || s === 'RETRYING' || s === 'PENDING_RETRY');
  }).length;
  const todayCompleted = Object.values(runsBySchedule)
    .flat()
    .filter((r) => (r.status === 'success' || r.status === 'completed') && isTodayIst(r.runAt))
    .length;
  const nextRun = jobs
    .filter((j) => j.enabled && j.nextRun)
    .sort((a, b) => new Date(a.nextRun!).getTime() - new Date(b.nextRun!).getTime())[0];

  // Merge live SSE state onto a job (backed by the server scheduler + bus).
  const liveFor = (job: ScheduleJob) => scheduleStates.get(job._id);
  const liveRunningCount = jobs.filter((j) => liveFor(j)?.status === 'running').length;
  const liveNotReady = recentEvents.filter((e) => e.event === 'PACKAGE_READY').length;

  const act = async (url: string, opts?: RequestInit) => {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: opts?.body ?? '{}', ...opts });
      return res.ok;
    } catch {
      return false;
    }
  };

  const runNow = async (job: ScheduleJob) => {
    setRunningSet((prev) => new Set(prev).add(job._id));
    const ok = await act(`/api/phase2/schedules/${encodeURIComponent(job._id)}`, { body: JSON.stringify({ action: 'run' }) });
    if (ok) {
      setTimeout(() => fetchData(), 1500);
    }
    setRunningSet((prev) => {
      const next = new Set(prev); next.delete(job._id); return next;
    });
  };

  const toggleEnabled = async (job: ScheduleJob) => {
    const ok = await act(`/api/phase2/schedules/${encodeURIComponent(job._id)}`);
    if (ok) fetchData();
    else fetchData();
  };

  const removeJob = async (job: ScheduleJob) => {
    if (!window.confirm(`Delete schedule "${job.name}"? Historical execution records will be kept.`)) return;
    try {
      await fetch(`/api/phase2/schedules/${encodeURIComponent(job._id)}`, { method: 'DELETE' });
      fetchData();
    } catch {
      fetchData();
    }
  };

  return (
    <div className="space-y-4 pb-2">
      <PageHeader title="Schedules" subtitle="Automated daily data-download jobs">
        {data && (
          <div className="mr-1 hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex" title={connected ? 'Live scheduler feed connected' : 'Live feed disconnected — retrying'}>
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success' : 'bg-destructive'} ${connected ? '' : 'animate-pulse'}`} />
            {connected ? 'Live' : 'Reconnecting'}
          </div>
        )}
        <Button asChild size="sm">
          <Link href="/data-saver/schedules/new"><Plus className="h-3.5 w-3.5 mr-1" /> Create Schedule</Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={retry}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

      {loadError && (
        <SectionCard title="Schedules — problem loading" icon={CalendarClock}>
          <InlineError reason={loadError} onRetry={retry} />
        </SectionCard>
      )}

      {loading && !data ? (
        <LoadingState text="Loading schedules..." />
      ) : (
        <>
          {/* ===================== SUMMARY ===================== */}
          <section aria-label="Summary" className="space-y-2">
            <SectionHeading>Summary</SectionHeading>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard icon={CalendarClock} title="Active Schedules" tone="success" value={fmtCompact(activeCount) as any} sub={`${jobs.length} total`} />
              <StatCard icon={Clock} title="Next Execution" tone="cyan" value={nextRun ? <Countdown to={nextRun.nextRun} /> : '—'} sub={nextRun?.name} />
              <StatCard icon={CheckCircle2} title="Completed Today" tone="success" value={fmtCompact(todayCompleted) as any} sub="executions" />
              <StatCard icon={Loader2} title="Live Running" tone={liveRunningCount > 0 ? 'blue' : 'neutral'} value={fmtCompact(liveRunningCount) as any} sub={liveRunningCount > 0 ? 'executing now' : 'idle'} />
            </div>
          </section>

          {/* ===================== DEPENDENCIES ===================== */}
          {health && (
            <section aria-label="Dependencies" className="space-y-2">
              <SectionHeading>Scheduler Dependencies</SectionHeading>
              <SectionCard title="Dependency Health" icon={Database} className="min-h-[60px]">
                {deps.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No dependency report available.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {deps.map((c: any) => (
                      <div key={c.dependency} className="rounded-lg border border-border bg-card/40 p-2 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${c.available ? 'bg-success' : 'bg-destructive'}`} />
                          <span className="text-[10px] font-semibold capitalize">{c.dependency}</span>
                        </div>
                        <p className="mt-0.5 text-[9px] text-muted-foreground leading-tight truncate" title={c.reason}>
                          {c.available ? 'Online' : 'Offline'}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                {market && (
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    Market: <b className="text-foreground capitalize">{market.market_status || '—'}</b> · {market.market_date} ·{' '}
                    {market.trading_day ? 'Trading day' : (market.closure_reason || 'Non-trading day')}
                  </p>
                )}
              </SectionCard>
            </section>
          )}

          {/* ===================== SCHEDULES ===================== */}
          <section aria-label="Schedules" className="space-y-2">
            <SectionHeading>Schedules ({jobs.length})</SectionHeading>
            {data?.ok === false ? (
              <SectionCard title="Scheduler" icon={CalendarClock}>
                <InlineError reason={data.reason} onRetry={retry} />
              </SectionCard>
            ) : jobs.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                title="No schedules yet"
                description="Create a schedule to automate daily data export."
                action={<Button asChild size="sm"><Link href="/data-saver/schedules/new"><Plus className="h-3.5 w-3.5 mr-1" /> Create Schedule</Link></Button>}
              />
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => {
                  const meta = statusMeta(job.lastStatus, job.enabled);
                  const live = liveFor(job);
                  const isLiveRunning = live?.status === 'running';
                  const isLiveDue = live?.status === 'due';
                  const displayMeta = isLiveRunning ? { tone: 'info' as const, label: 'Running…' }
                    : isLiveDue ? { tone: 'warning' as const, label: 'Due now' }
                    : (live && ['success', 'failed', 'waiting', 'retrying', 'skipped', 'missed'].includes(live.status)
                        ? liveStatusMeta(live.status)
                        : meta);
                  const open = detailOpen.has(job._id);
                  const runs = (runsBySchedule[job._id] ?? []).slice(0, 6);
                  const isRunning = runningSet.has(job._id);
                  const jobDownloading = live?.packageReady ? downloading[String(live.packageReady.packageId)] : undefined;
                  const stockCount = job.symbolMode === 'custom'
                    ? (job.symbols?.length ?? 0)
                    : (job.symbolMode === 'all' ? 'All' : 'Active');
                  const fieldCount = job.fields?.length ?? null;
                  const fmtCount = (job.formats ?? []).map((f) => f.toUpperCase()).join(', ') || '—';

                  return (
                    <SectionCard
                      key={job._id}
                      title={job.name}
                      icon={CalendarClock}
                      className={isLiveRunning ? 'ring-1 ring-info/40' : undefined}
                      headerRight={
                        <div className="flex items-center gap-2">
                          {isLiveRunning && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-info">
                              <Loader2 className="h-3 w-3 animate-spin" /> executing
                            </span>
                          )}
                          {jobDownloading === 'running' && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-info">
                              <Download className="h-3 w-3 animate-bounce" /> downloading
                            </span>
                          )}
                          {jobDownloading === 'done' && <StatusBadge status="success" label="Downloaded" />}
                          <StatusBadge status={displayMeta.tone} label={displayMeta.label} />
                          <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => runNow(job)} disabled={isRunning || isLiveRunning}>
                            {isRunning ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            Run Now
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => toggleEnabled(job)} title={job.enabled ? 'Pause' : 'Resume'}>
                            {job.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                          </Button>
                          <Button asChild size="sm" variant="ghost" className="h-7" title="Edit">
                            <Link href={`/data-saver/schedules/new?edit=${job._id}`}><Pencil className="h-3.5 w-3.5" /></Link>
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={() => removeJob(job)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => toggle(job._id)} title="Details">
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      }
                    >
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div>
                          <p className="text-[11px] text-muted-foreground">Stocks</p>
                          <p className="font-medium">{typeof stockCount === 'number' ? `${stockCount} selected` : stockCount}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Format</p>
                          <p className="font-medium">{fmtCount}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Fields</p>
                          <p className="font-medium">{fieldCount != null ? `${fieldCount} fields` : 'Default'}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Repeat</p>
                          <p className="font-medium">{scheduleRuleText(job)} · {scheduleTimeText(job)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Next Run</p>
                          <p className="font-medium tabular-nums">
                            {job.enabled ? <Countdown to={job.nextRun} recording={isLiveRunning} /> : 'Paused'}
                          </p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Last Run</p>
                          <p className="font-medium tabular-nums">{ist(job.lastRun)}</p>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Last Result</p>
                          <div className="flex items-center gap-1.5">
                            <StatusBadge status={displayMeta.tone} label={displayMeta.label} />
                            {job.lastError && job.lastStatus && !['success', 'completed'].includes((job.lastStatus || '').toLowerCase()) && (
                              <span className="truncate text-[10px] text-muted-foreground" title={job.lastError}>{job.lastError}</span>
                            )}
                          </div>
                        </div>
                        <div>
                          <p className="text-[11px] text-muted-foreground">Data Range</p>
                          <p className="font-medium capitalize">{(job.dateRange?.type || 'previous_day').replace(/_/g, ' ')}</p>
                        </div>
                      </div>

                      {job.lastFile && job.historyId && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Badge variant="secondary" className="gap-1 text-[10px]">
                            <FileArchive className="h-3 w-3" /> {job.lastFile} · {fmtBytes(job.lastFileSize)}
                          </Badge>
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" asChild>
                            <a href={`/api/phase2/download-history/${job.historyId}/file`} download={job.lastFile}>
                              <Download className="h-3 w-3" /> Download Package
                            </a>
                          </Button>
                        </div>
                      )}

                      {job.lastStatus && ['WAITING_FOR_DEPENDENCY', 'WAITING', 'PENDING_RETRY'].includes((job.lastStatus || '').toUpperCase()) && (
                        <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px]">
                          <b className="text-warning">Export waiting</b>
                          <p className="text-muted-foreground">Reason: {job.failure_reason || job.lastError || 'Dependency unavailable'}</p>
                          {job.nextRetryAt && <p className="text-muted-foreground">Next retry: {ist(job.nextRetryAt)}</p>}
                        </div>
                      )}

                      {/* Details */}
                      {open && (
                        <div className="mt-4 border-t border-border/60 pt-3">
                          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3 text-[11px]">
                            <Field label="Schedule ID" value={<span className="font-mono">{job._id}</span>} />
                            <Field label="Status" value={meta.label} />
                            <Field label="Created at" value={ist(job.createdAt)} />
                            <Field label="Updated at" value={ist(job.updatedAt)} />
                            <Field label="Timezone" value={(job.schedule?.timezone || job.timezone || 'Asia/Kolkata')} />
                            <Field label="Location" value={(job.schedule?.timezone || 'Asia/Kolkata').includes('Kolkata') ? 'India' : (job.schedule?.timezone || '—')} />
                            <Field label="Start date" value={istDate(job.createdAt)} />
                            <Field label="End date" value="No end date" />
                            <Field label="Repeat rule" value={scheduleRuleText(job)} />
                            <Field label="Execution count" value={fmtCompact(job.runCount) as any} />
                            <Field label="Retry count" value={fmtCompact(job.retry_count) as any} />
                            <Field label="Stocks (symbols)" value={job.symbolMode === 'custom' ? (job.symbols?.length ?? 0) : job.symbolMode} />
                          </div>

                          {/* Execution history */}
                          <p className="mt-4 mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Execution History</p>
                          {runs.length === 0 ? (
                            <p className="text-[11px] text-muted-foreground">No executions yet.</p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full text-[11px]">
                                <thead>
                                  <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                                    <th className="py-1.5 pr-2 font-semibold">Date</th>
                                    <th className="py-1.5 pr-2 font-semibold">Trigger</th>
                                    <th className="py-1.5 pr-2 font-semibold">Status</th>
                                    <th className="py-1.5 pr-2 font-semibold text-right">Records</th>
                                    <th className="py-1.5 pr-2 font-semibold text-right">Zip</th>
                                    <th className="py-1.5 font-semibold">Download</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {runs.map((r) => {
                                    const rm = statusMeta(r.status, true);
                                    return (
                                      <tr key={r._id} className="border-b border-border/30">
                                        <td className="py-1.5 pr-2 tabular-nums whitespace-nowrap">{ist(r.runAt)}</td>
                                        <td className="py-1.5 pr-2 capitalize">{r.trigger ?? '—'}</td>
                                        <td className="py-1.5 pr-2"><StatusBadge status={rm.tone} label={rm.label} /></td>
                                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtCompact(r.recordCount) as any}</td>
                                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtBytes(r.fileSizeBytes)}</td>
                                        <td className="py-1.5">
                                          {r.historyId && r.fileName ? (
                                            <Button size="sm" variant="ghost" className="h-6 gap-1 text-[10px]" asChild>
                                              <a href={`/api/phase2/download-history/${r.historyId}/file`} download={r.fileName}><Download className="h-3 w-3" /></a>
                                            </Button>
                                          ) : <span className="text-[10px] text-muted-foreground">—</span>}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {runs.some((r) => r.error) && (
                            <p className="mt-2 text-[10px] text-muted-foreground">Last error: {runs.find((r) => r.error)?.error || '—'}</p>
                          )}
                        </div>
                      )}
                    </SectionCard>
                  );
                })}
              </div>
            )}
          </section>

          {/* ===================== LIVE ACTIVITY ===================== */}
          <section aria-label="Live activity" className="space-y-2">
            <SectionHeading>
              <span className="inline-flex items-center gap-1.5">
                <Radio className={`h-3.5 w-3.5 ${connected ? 'text-success' : 'text-muted-foreground'}`} />
                Live Activity
              </span>
            </SectionHeading>
            <SectionCard title="Realtime event feed" icon={Radio} className="min-h-[80px]">
              {!connected ? (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting to live event stream…
                </div>
              ) : recentEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No scheduler events yet. Events appear here live as schedules run.</p>
              ) : (
                <ul className="space-y-1.5">
                  {recentEvents.slice(0, 12).map((ev) => (
                    <li key={ev.eventId} className="flex items-start gap-2 text-[11px] leading-relaxed">
                      <StatusBadge status={eventTone(ev.event)} label={EVENT_LABELS[ev.event] ?? ev.event} />
                      <span className="min-w-0 flex-1 text-foreground">{summary(ev)}</span>
                      <span className="whitespace-nowrap text-muted-foreground tabular-nums">{eventTime(ev.ts)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </section>

          {autoLog.length > 0 && (
            <section aria-label="Auto downloads" className="space-y-2">
              <SectionHeading>Auto Downloads</SectionHeading>
              <SectionCard title="Packages downloaded automatically" icon={Download} className="min-h-[50px]">
                <ul className="space-y-1">
                  {autoLog.slice(0, 8).map((line, i) => (
                    <li key={i} className="flex items-start gap-2 text-[11px] text-muted-foreground">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </section>
          )}
        </>
      )}
    </div>
  );
}
