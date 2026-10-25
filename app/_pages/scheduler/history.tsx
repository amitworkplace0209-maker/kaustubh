'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, FilterX, ListChecks, RefreshCw, Search, Timer,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { getSchedulerRun, getSchedulerRuns } from '@/lib/api';
import {
  fmtClockIST, fmtDateTimeIST, fmtDuration, fmtNum, fmtTs,
  RUN_SORT_OPTIONS, RUN_STATUS_OPTIONS, RUN_VIEW, useScheduleEvents,
} from '@/app/_pages/scheduler/scheduler-data';

/**
 * SERVICES -> Scheduler -> History (renamed from Runs)
 *
 * The persisted scheduler-run ledger (Mongo ``scheduler_runs``) served by
 * GET /api/scheduler/runs with server-side filtering + pagination. Every value
 * is real: timestamps come from the run record, duration is computed from the
 * actual started/completed timestamps, status/trigger/reason/error are the
 * stored values. The page refetches on scheduler SSE events (the project's
 * existing realtime channel) plus manual Refresh — no duplicate polling.
 *
 * Column "Next Retry" is honest: this executor has no scheduled retry instant,
 * so the backend returns null and the cell always renders "—" (see header
 * tooltip). A caught-up run renders its real status badge + a CATCH-UP chip.
 */
export default function SchedulerHistoryPage() {
  const { connected, refreshKey } = useScheduleEvents();

  const [date, setDate] = useState('');
  const [job, setJob] = useState('');
  const [status, setStatus] = useState('');
  const [trigger, setTrigger] = useState('');
  const [schedule, setSchedule] = useState('');
  const [search, setSearch] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [catchUpOnly, setCatchUpOnly] = useState(false);
  const [sort, setSort] = useState('scheduled_at');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(15);
  const [pageInput, setPageInput] = useState('1');

  const [data, setData] = useState<{
    runs: RunRecord[]; total: number; pages: number; page: number; count: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const reqRef = useRef(0);

  const [detail, setDetail] = useState<RunRecord | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const hasFilters = !!searchApplied || !!date || !!job || !!status || !!trigger
    || !!schedule || failedOnly || catchUpOnly;

  // ------------------------------------------------------------------
  const params = useMemo(() => {
    const p: Record<string, string | number | boolean | undefined | null> = {
      page,
      page_size: pageSize,
      sort,
      order,
    };
    if (date) p.business_date = date;
    if (job) p.job_id = job;
    if (status) p.status = status;
    if (trigger) p.trigger = trigger;
    if (schedule) p.schedule_id = schedule;
    if (searchApplied) p.search = searchApplied;
    if (failedOnly) p.failed_only = true;
    if (catchUpOnly) p.catch_up_only = true;
    return p;
  }, [page, pageSize, sort, order, date, job, status, trigger, schedule, searchApplied, failedOnly, catchUpOnly]);

  const fetchRuns = async () => {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const res = await getSchedulerRuns(params);
      if (req !== reqRef.current) return;
      setData(res);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e: any) {
      if (req !== reqRef.current) return;
      setError(e?.message ?? 'Failed to load scheduler runs.');
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  };

  // Initial + filter/page/sort change + scheduler SSE event.
  useEffect(() => {
    void fetchRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params)]);

  useEffect(() => {
    if (refreshKey > 0) void fetchRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const applySearch = () => { setPage(1); setSearchApplied(search.trim()); };
  const resetFilters = () => {
    setDate(''); setJob(''); setStatus(''); setTrigger(''); setSchedule('');
    setSearch(''); setSearchApplied(''); setFailedOnly(false); setCatchUpOnly(false);
    setSort('scheduled_at'); setOrder('desc'); setPage(1); setPageInput('1');
  };

  // ------------------------------------------------------------------
  const openDetail = async (runId: string) => {
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    // optimistic fill from the already-loaded row
    const row = data?.runs.find((r) => r.run_id === runId) ?? null;
    if (row) setDetail(row);
    try {
      const res = await getSchedulerRun(runId);
      setDetail(res?.run ?? row);
      setDetailError(null);
    } catch (e: any) {
      setDetailError(e?.message ?? 'Run detail unavailable.');
    } finally {
      setDetailLoading(false);
    }
  };

  const stale = lastUpdated != null && Date.now() - lastUpdated > 30_000;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ListChecks className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Scheduler History</h1>
            <p className="text-xs text-muted-foreground">
              Persisted <span className="font-mono">scheduler_runs</span> ledger
              {data ? <> · {fmtNum(data.total)} runs</> : null} · IST (+05:30)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={connected ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300' : 'border-amber-500/30 bg-amber-500/15 text-amber-300'}>
            {connected ? 'LIVE' : 'OFFLINE'}
          </Badge>
          <Badge variant="outline">
            Last updated: {lastUpdated ? fmtClockIST(new Date(lastUpdated).toISOString()) : '\u2014'} IST
          </Badge>
          {stale && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/15 text-amber-300">STALE DATA</Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => void fetchRuns()}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* Filters */}
      <Card className="shadow-soft">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Filters</CardTitle>
          {hasFilters && (
            <Button size="sm" variant="ghost" onClick={resetFilters} className="h-7 text-xs">
              <FilterX className="mr-1 h-3 w-3" /> Reset
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
            <label className="col-span-2 flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground md:col-span-2 xl:col-span-2">
              Business date
              <Input type="date" value={date} onChange={(e) => { setPage(1); setDate(e.target.value); }} className="h-8 text-xs" />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Job (id)
              <Input value={job} placeholder="login | ws_start" onChange={(e) => { setPage(1); setJob(e.target.value); }} className="h-8 text-xs" />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Status
              <Select value={status} onValueChange={(v) => { setPage(1); setStatus(v === 'all' ? '' : v); }}>
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {RUN_STATUS_OPTIONS.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Trigger
              <Input value={trigger} placeholder="MISSED_SCHEDULE_CATCHUP" onChange={(e) => { setPage(1); setTrigger(e.target.value); }} className="h-8 text-xs" />
            </label>
            <label className="col-span-2 flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Schedule (id)
              <Input value={schedule} placeholder="session_login" onChange={(e) => { setPage(1); setSchedule(e.target.value); }} className="h-8 text-xs" />
            </label>
            <label className="col-span-2 flex items-end gap-1 md:col-span-4 xl:col-span-2">
              <Input value={search} placeholder="Search job / id / reason / error"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
                className="h-8 text-xs" />
              <Button size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={applySearch}>
                <Search className="h-3.5 w-3.5" />
              </Button>
            </label>
            <label className="col-span-2 flex items-center gap-2 md:col-span-2 xl:col-span-4">
              <button
                type="button"
                onClick={() => { setPage(1); setFailedOnly((v) => !v); }}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${failedOnly ? 'border-rose-500/30 bg-rose-500/15 text-rose-300' : 'border-border/60 text-muted-foreground'}`}
              >
                <input type="checkbox" checked={failedOnly} readOnly className="h-3 w-3 accent-rose-500" /> Failed only
              </button>
              <button
                type="button"
                onClick={() => { setPage(1); setCatchUpOnly((v) => !v); }}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${catchUpOnly ? 'border-sky-500/30 bg-sky-500/15 text-sky-300' : 'border-border/60 text-muted-foreground'}`}
              >
                <input type="checkbox" checked={catchUpOnly} readOnly className="h-3 w-3 accent-sky-500" /> Catch-up only
              </button>
            </label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="uppercase tracking-wider text-muted-foreground">Sort</span>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-7 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RUN_SORT_OPTIONS.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setPage(1); setOrder((o) => (o === 'asc' ? 'desc' : 'asc')); }}>
              {order === 'asc' ? <><ArrowUp className="mr-1 h-3 w-3" /> Ascending</> : <><ArrowDown className="mr-1 h-3 w-3" /> Descending</>}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="shadow-soft">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">History</CardTitle>
          {data ? (
            <Badge variant="outline">{fmtNum(data.total)}</Badge>
          ) : null}
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <div className="space-y-2 py-8">
              <div className="h-8 animate-pulse rounded bg-white/5" />
              <div className="h-8 animate-pulse rounded bg-white/5" />
              <div className="h-8 animate-pulse rounded bg-white/5" />
            </div>
          ) : !data || data.runs.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              {hasFilters
                ? 'No scheduler runs match the current filters.'
                : 'No scheduler runs recorded yet.'}
            </div>
          ) : (
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/60">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Run ID</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Job</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Status</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Trigger</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Scheduled (IST)</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Actual start (IST)</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Actual comp. (IST)</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Duration</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Attempt</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Reason</TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Error</TableHead>
                    <TableHead
                      className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase"
                      title="No scheduled retry — the reconcile loop re-evaluates each window on its own clock"
                    >
                      Next retry
                    </TableHead>
                    <TableHead className="sticky top-0 bg-muted/60 px-2 py-2 text-[10px] uppercase">Updated (IST)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.runs.map((r) => (
                    <RunRow key={r.run_id ?? r.execution_id} run={r} onOpen={() => openDetail(r.run_id ?? r.execution_id)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {data && data.pages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                Page {fmtNum(data.page)} of {fmtNum(data.pages)} · {fmtNum(data.total)} runs
              </span>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => { setPage(1); setPageInput('1'); }}>First</Button>
                <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); setPageInput(String(Math.max(1, data.page - 1))); }}>Prev</Button>
                <Input
                  type="number" min={1} max={data.pages} value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={() => { const n = Math.min(Math.max(parseInt(pageInput, 10) || 1, 1), data.pages); setPage(n); setPageInput(String(n)); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { const n = Math.min(Math.max(parseInt(pageInput, 10) || 1, 1), data.pages); setPage(n); setPageInput(String(n)); } }}
                  className="h-7 w-16 text-center text-xs"
                />
                <Button size="sm" variant="outline" disabled={data.page >= data.pages} onClick={() => { setPage((p) => Math.min(data.pages, p + 1)); setPageInput(String(Math.min(data.pages, data.page + 1))); }}>Next</Button>
                <Button size="sm" variant="outline" disabled={data.page >= data.pages} onClick={() => { setPage(data.pages); setPageInput(String(data.pages)); }}>Last</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Run detail drawer */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-primary" /> Run detail
            </SheetTitle>
            <SheetDescription>Real persisted values from the scheduler run ledger.</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-2 text-xs">
            {detailError && <div className="rounded bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{detailError}</div>}
            {detailLoading && !detail && <div className="py-6 text-center text-muted-foreground">Loading run detail…</div>}
            {detail && (
              <>
                <div className="rounded-lg border">
                  {(detailRow('Run ID', detail.run_id, true))}
                  {(detailRow('Business date', detail.business_date))}
                  {(detailRow('Schedule id', detail.schedule_id))}
                  {(detailRow('Status', detail.status, false, true))}
                  {detail.catch_up && (
                    <div className="flex justify-between border-t px-3 py-2"><span className="text-muted-foreground">Catch-up</span><Badge variant="outline" className="border-sky-500/30 bg-sky-500/15 text-sky-300">MISSED_SCHEDULE_CATCHUP</Badge></div>
                  )}
                  {(detailRow('Trigger', detail.trigger))}
                  {(detailRow('Scheduled (IST)', fmtDateTimeIST(detail.scheduled_at)))}
                  {(detailRow('Actual start (IST)', fmtDateTimeIST(detail.actual_start)))}
                  {(detailRow('Actual completion (IST)', fmtDateTimeIST(detail.actual_completion)))}
                  {(detailRow('Duration', fmtDuration(detail.duration_ms)))}
                  {(detailRow('Attempt', detail.attempt != null ? fmtNum(detail.attempt) : '\u2014'))}
                  {(detailRow('Reason', detail.reason))}
                  {(detailRow('Reason code', detail.reason_code))}
                  {(detailRow('Error', detail.error, true))}
                  <div className="flex justify-between border-t px-3 py-2">
                    <span className="text-muted-foreground">Next retry</span>
                    <span className="font-mono text-muted-foreground">{'\u2014'}</span>
                  </div>
                  {(detailRow('Created (IST)', fmtTs(detail.created_at)))}
                  {(detailRow('Updated (IST)', fmtTs(detail.updated_at)))}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Next retry: this executor schedules no retries — the reconcile loop re-evaluates each window on its own clock.
                </p>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------

type RunRecord = {
  run_id: string;
  execution_id: string;
  occurrence_id?: string | null;
  schedule_id?: string | null;
  job_id: string | null;
  job_type?: string | null;
  business_date?: string | null;
  status: string | null;
  raw_status?: string | null;
  catch_up?: boolean;
  trigger?: string | null;
  scheduled_at?: string | null;
  actual_start?: string | null;
  actual_completion?: string | null;
  duration_ms?: number | null;
  attempt?: number | null;
  reason?: string | null;
  reason_code?: string | null;
  error?: string | null;
  next_retry?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function RunRow({ run, onOpen }: { run: RunRecord; onOpen: () => void }) {
  const view = RUN_VIEW[run.status ?? ''] ?? { label: run.status ?? '\u2014', tone: '' };
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell className="max-w-[9rem] truncate px-2 py-1.5 font-mono text-[10px] text-muted-foreground"
        title={run.run_id ?? run.execution_id}>
        {shortRunId(run.run_id ?? run.execution_id)}
      </TableCell>
      <TableCell className="px-2 py-1.5 font-medium">
        {run.job_id ?? '\u2014'}
        {run.schedule_id ? <span className="ml-1 font-mono text-[9px] text-muted-foreground">{run.schedule_id}</span> : null}
      </TableCell>
      <TableCell className="px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline" className={view.tone}>{view.label}</Badge>
          {run.catch_up && <Badge variant="outline" className="border-sky-500/30 bg-sky-500/15 text-sky-300">CATCH-UP</Badge>}
        </div>
      </TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px]">{run.trigger ?? '\u2014'}</TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px]">{fmtHHMMish(run.scheduled_at)}</TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px]">{fmtClockIST(run.actual_start)}</TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px]">{fmtClockIST(run.actual_completion)}</TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px]">{fmtDuration(run.duration_ms)}</TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px]">{run.attempt != null ? fmtNum(run.attempt) : '\u2014'}</TableCell>
      <TableCell className="max-w-[13rem] px-2 py-1.5 font-mono text-[10px] text-muted-foreground"
        title={run.reason ?? run.reason_code ?? ''}>
        <span className="line-clamp-1">{run.reason ?? run.reason_code ?? '\u2014'}</span>
      </TableCell>
      <TableCell className="max-w-[10rem] px-2 py-1.5 font-mono text-[10px] text-muted-foreground" title={run.error ?? ''}>
        <span className={run.error ? 'line-clamp-1 text-rose-300' : 'line-clamp-1'}>{run.error ?? '\u2014'}</span>
      </TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground" title="No scheduled retry — reconcile re-evaluates each window">{'\u2014'}</TableCell>
      <TableCell className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground" title={fmtTs(run.updated_at)}>{fmtClockIST(run.updated_at)}</TableCell>
    </TableRow>
  );
}

function detailRow(label: string, value: string | number | null | undefined, mono = false, badge = false) {
  const text = value == null || value === '' ? '\u2014' : String(value);
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 border-t px-3 py-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="break-all">
        {badge ? (
          <Badge variant="outline" className={(RUN_VIEW[text] as { tone?: string } | undefined)?.tone ?? ''}>{text}</Badge>
        ) : (
          <span className={`font-mono ${mono ? 'text-muted-foreground' : ''}`}>{text}</span>
        )}
      </span>
    </div>
  );
}

function shortRunId(id?: string | null): string {
  if (!id) return '\u2014';
  return id.replace(/:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, ':..').slice(0, 20);
}

/** HH:MM for a scheduled instant (full datetime available on hover). */
function fmtHHMMish(iso?: string | null): string {
  if (iso == null || iso === '') return '\u2014';
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return typeof iso === 'string' ? iso.slice(0, 5) : '\u2014';
}