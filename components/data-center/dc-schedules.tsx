'use client';

// ---- Data Center scheduled exports ----
// Real jobs from the backend scheduler. Actions shown are exactly those the
// backend supports: Pause/Resume (toggle), Run Now, Edit (PUT), Duplicate
// (create copy) and Delete. A runs-history panel lists every recorded
// execution attempt (schedule_runs collection).

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarClock, Copy, History, Inbox, Pencil, Play, Plus, PowerOff,
  RefreshCw, Trash2, Zap,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  createScheduledDownload, deleteScheduledDownload, getScheduledDownloads,
  getScheduleRuns, runScheduledDownloadNow, toggleScheduledDownload,
} from '@/lib/api';

type Job = {
  _id: string;
  name: string;
  enabled: boolean;
  symbolMode: string;
  symbols: string[] | null;
  formats: string[];
  fields?: string[];
  schedule: { type: string; time: string; days?: number[] };
  dateRange: { type: string; days?: number; startDate?: string; endDate?: string };
  destination: string;
  timezone?: string;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastFile: string | null;
  lastFileSize: number | null;
  failCount?: number;
  runCount: number;
};

type ScheduleRun = {
  _id: string;
  scheduleId: string;
  scheduleName?: string;
  trigger?: string;
  status: string;
  runAt: string;
  stocks?: string[];
  symbolCount?: number;
  fileName?: string;
  fileSizeBytes?: number;
  recordCount?: number;
  durationMs?: number;
  error?: string | null;
};

const FREQ_LABEL: Record<string, string> = {
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Custom days',
};

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtWhen(iso: string | null): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? '\u2014'
    : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

function fmtSize(bytes?: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function tzShort(tz?: string): string {
  // "Asia/Kolkata" → "IST", fall back to the offset.
  if (!tz) return 'IST';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz.split('/').pop() ?? tz;
  } catch {
    return tz.split('/').pop() ?? tz;
  }
}

function statusBadge(status?: string | null) {
  const s = (status ?? '').toLowerCase();
  const cls =
    s === 'success' ? 'border-success/30 bg-success/10 text-success'
      : s === 'failed' || s === 'error' ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : s === 'running' ? 'border-primary/30 bg-primary/10 text-primary'
          : s === 'skipped' || s === 'retry' ? 'border-warning/40 bg-warning/10 text-warning'
            : 'border-border/50 bg-muted/30 text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('h-5 px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider', cls)}>
      {s || '\u2014'}
    </Badge>
  );
}

function freqLabel(job: Job): string {
  let label = FREQ_LABEL[job.schedule.type] ?? job.schedule.type;
  if (job.schedule.type === 'weekly' && job.schedule.days?.length) {
    label += ` (${job.schedule.days.map((d) => DAY_LABEL[d] ?? d).join(', ')})`;
  }
  return `${label} @ ${job.schedule.time} ${tzShort(job.timezone)}`;
}

export default function DcSchedules() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [jobsData, runsData] = await Promise.all([
        getScheduledDownloads(),
        getScheduleRuns({ limit: 8 }).catch(() => ({ items: [] })),
      ]);
      setJobs(jobsData.jobs ?? []);
      setRuns(runsData.items ?? []);
    } catch { /* keep previous */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden && !busyId) fetchData();
    }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = async (id: string, action: () => Promise<unknown>, okMsg?: string) => {
    setBusyId(id);
    try {
      await action();
      if (okMsg) toast({ title: okMsg });
      await fetchData();
    } catch (err) {
      // Surface backend validation messages verbatim (e.g. duplicate name).
      const message = err instanceof Error ? err.message : String(err);
      toast({ title: 'Action failed', description: message.replace(/^\d+\s*/, ''), variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = jobs.filter((j) => j.enabled).length;

  return (
    <div className="space-y-4">
      <Card className="shadow-soft">
        <CardContent className="px-4 py-3.5">
          {/* Header */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
              <CalendarClock className="h-3.5 w-3.5" />
            </span>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Scheduled Exports</h3>
            {activeCount > 0 && (
              <Badge variant="outline" className="h-5 border-success/30 bg-success/10 px-1.5 py-0 text-[10px] font-bold text-success">
                {activeCount} ACTIVE
              </Badge>
            )}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={fetchData}>
                <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> Refresh
              </Button>
              <Button size="sm" className="h-7 gap-1.5 rounded-lg text-xs" onClick={() => router.push('/data-saver/schedules/new')}>
                <Plus className="h-3 w-3" /> New Schedule
              </Button>
            </div>
          </div>

          {/* Table */}
          {loading && jobs.length === 0 ? (
            <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/50" />)}</div>
          ) : jobs.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-8 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm font-medium">No schedules yet</p>
              <p className="text-xs text-muted-foreground">Create a schedule to export tick data automatically.</p>
              <Button size="sm" variant="outline" className="mt-1 h-7 gap-1.5 rounded-lg text-xs" onClick={() => router.push('/data-saver/schedules/new')}>
                <Plus className="h-3 w-3" /> Create first schedule
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/40">
              {/* Header row */}
              <div className="hidden grid-cols-[minmax(140px,1fr)_minmax(110px,0.9fr)_minmax(150px,1fr)_110px_110px_90px_minmax(150px,0.9fr)] items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground lg:grid">
                <span>Name</span><span>Stocks</span><span>Frequency</span>
                <span className="text-right">Next Run</span><span className="text-right">Last Run</span>
                <span className="text-center">Status</span><span className="text-right">Actions</span>
              </div>
              <div className="divide-y divide-border/40">
                {jobs.map((job) => {
                  const busy = busyId === job._id;
                  return (
                    <div
                      key={job._id}
                      className={cn(
                        'grid grid-cols-1 gap-1.5 px-3 py-2.5 transition-colors hover:bg-muted/30 lg:grid-cols-[minmax(140px,1fr)_minmax(110px,0.9fr)_minmax(150px,1fr)_110px_110px_90px_minmax(150px,0.9fr)] lg:items-center lg:gap-2',
                        !job.enabled && 'bg-muted/20 opacity-90',
                      )}
                    >
                      {/* Name */}
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-semibold" title={job.name}>{job.name}</span>
                        {!job.enabled && (
                          <Badge variant="secondary" className="h-4 shrink-0 px-1 py-0 text-[8px] tracking-wider">PAUSED</Badge>
                        )}
                      </div>
                      {/* Stocks */}
                      <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {job.symbolMode === 'custom'
                          ? `${job.symbols?.length ?? 0} selected`
                          : job.symbolMode === 'all_active' ? 'All active' : 'All'}
                      </div>
                      {/* Frequency + timezone */}
                      <div className="truncate text-[11px] text-muted-foreground" title={freqLabel(job)}>
                        {freqLabel(job)}
                      </div>
                      {/* Next / last run */}
                      <div className="text-right font-mono text-[11px] tabular-nums">{fmtWhen(job.nextRun)}</div>
                      <div className="text-right font-mono text-[11px] tabular-nums">{fmtWhen(job.lastRun)}</div>
                      {/* Status */}
                      <div className="flex justify-start lg:justify-center">{statusBadge(job.lastStatus)}</div>
                      {/* Actions — only what the backend supports */}
                      <div className="flex items-center justify-end gap-0.5">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={busy} title="Run now"
                          onClick={() => guard(job._id, () => runScheduledDownloadNow(job._id), 'Job started')}>
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={busy}
                          title={job.enabled ? 'Pause' : 'Resume'}
                          onClick={() => guard(job._id, () => toggleScheduledDownload(job._id))}>
                          {job.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />}
                        </Button>
                        <Button size="sm" variant="ghost" className="hidden h-7 w-7 p-0 sm:flex" disabled={busy} title="Edit"
                          onClick={() => router.push(`/data-saver/schedules/new?edit=${job._id}`)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="hidden h-7 w-7 p-0 md:flex" disabled={busy} title="Duplicate"
                          onClick={() => guard(
                            job._id,
                            () => createScheduledDownload({
                              name: `${job.name} (copy)`, enabled: false,
                              symbolMode: job.symbolMode, symbols: job.symbols,
                              formats: job.formats, schedule: job.schedule,
                              dateRange: job.dateRange, destination: job.destination,
                              timezone: job.timezone ?? 'Asia/Kolkata',
                            }),
                            'Duplicated (paused)',
                          )}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" disabled={busy} title="Delete"
                          onClick={() => guard(job._id, () => deleteScheduledDownload(job._id), `Deleted: ${job.name}`)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {(job.lastError || job.failCount) != null && job.lastError && (
                        <p className="truncate text-[11px] text-destructive lg:col-span-7" title={job.lastError}>
                          {job.lastError}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Runs history — every recorded execution attempt */}
      <Card className="shadow-soft">
        <CardContent className="px-4 py-3.5">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple/10 text-purple ring-1 ring-inset ring-purple/25">
              <History className="h-3.5 w-3.5" />
            </span>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Run History</h3>
            <Badge variant="outline" className="ml-auto h-5 border-border/50 bg-muted/40 px-1.5 py-0 text-[10px]">
              last {runs.length} attempts
            </Badge>
          </div>

          {runs.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-6 text-center">
              <Inbox className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm font-medium">No runs recorded yet</p>
              <p className="text-xs text-muted-foreground">Every scheduled or manual run is logged here.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/40">
              <div className="divide-y divide-border/40">
                {runs.map((run) => (
                  <div key={run._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs hover:bg-muted/30">
                    {statusBadge(run.status)}
                    <span className="max-w-[180px] truncate font-semibold" title={run.scheduleName}>{run.scheduleName ?? '\u2014'}</span>
                    <span className="font-mono tabular-nums text-muted-foreground" title={run.runAt}>{fmtWhen(run.runAt)}</span>
                    <Badge variant="outline" className="h-4 border-border/50 px-1 py-0 text-[8px] uppercase tracking-wider text-muted-foreground">
                      {run.trigger === 'manual_run' ? 'MANUAL' : 'SCHEDULED'}
                    </Badge>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {run.symbolCount ?? 0} stocks{run.recordCount ? ` · ${(run.recordCount ?? 0).toLocaleString('en-IN')} rows` : ''}
                      {run.fileSizeBytes ? ` · ${fmtSize(run.fileSizeBytes)}` : ''}
                    </span>
                    <span className="ml-auto max-w-[240px] truncate font-mono text-[11px]" title={run.error ?? run.fileName}>
                      {run.status === 'success'
                        ? run.fileName ?? ''
                        : run.error ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
