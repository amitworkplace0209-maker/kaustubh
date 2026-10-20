'use client';

import {
  Activity, ArrowRight, CalendarDays, CheckCircle2, Clock4, ExternalLink,
  History, ListChecks, Radio, RefreshCw, Settings2, ShieldCheck, Timer, Zap,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
} from '@/components/design-system';
import {
  buildSchedulerTimeline,
  fmtClockIST, fmtDateTimeIST, fmtHHMM, fmtNum, fmtRemaining, fmtTs,
  LIFECYCLE_TONE, liveCountdown, RUN_VIEW, useLiveSchedulerEvents,
  useNow, useSchedulerData,
} from '@/app/_pages/scheduler/scheduler-data';

/**
 * SERVICES -> Scheduler Engine (Overview, redesigned)
 *
 * Real backend only — every value is fetched, never fabricated:
 *   engine    -> /api/services/engines/scheduler_engine (live + fallback)
 *   status    -> /api/scheduler/status   (state, phase, windows, next/last event)
 *   readiness -> /api/scheduler/readiness (spec §6 critical checks)
 *   summary   -> /api/scheduler/summary   (today counters, last/next event, executions)
 *   history   -> /api/scheduler/history   (newest-first persisted runs)
 *   live feed -> /api/schedule-events/stream (SSE realtime ticks)
 *
 * Layout: Now/Next hero (1s ticking) -> live event ticks -> today timeline ->
 * stats -> recent history. Heavy tables live on History / Timeline / Lifecycle.
 */
export default function SchedulerPage() {
  const {
    engine, engineError, status, statusError,
    readiness, readinessError,
    summary, summaryError, history, historyError,
    loading, reload,
  } = useSchedulerData();
  const { connected, events: liveEvents, lastMessageAt } = useLiveSchedulerEvents(12);
  const now = useNow(1000);

  const state = engine?.state ?? status?.schedulerState ?? summary?.scheduler_runtime_state ?? null;
  const phase = status?.phase ?? engine?.realStatus?.phase ?? summary?.phase ?? null;
  const realStatus = engine?.realStatus ?? {};
  const stale = lastMessageAt != null && now - lastMessageAt > 30_000;

  const nextEvent = summary?.next_event ?? null;
  const nextAt = status?.nextEventAt ?? nextEvent?.at_ist ?? summary?.next_event_at ?? null;
  const nextLabel = status?.nextEvent ?? nextEvent?.event ?? null;
  const lastRun = summary?.last_event ?? null;
  const ledgerRows: any[] = (history?.runs as any[]) || (summary?.executions as any[]) || [];
  const isTradingDay = summary?.is_trading_day ?? status?.isTradingDay ?? null;

  const checks: any[] = Array.isArray(readiness?.readiness?.checks)
    ? readiness.readiness.checks
    : Array.isArray(status?.readiness?.checks) ? status.readiness.checks : [];
  const readinessOverall = readiness?.readiness?.overall ?? status?.readiness?.overall ?? null;
  const critical = checks.filter((c) => c?.critical);
  const readyCount = critical.filter((c) => c?.ready).length;

  const timeline = buildSchedulerTimeline({ status, summary, history, now });
  const doneCount = timeline.filter((t) => t.tone === 'done').length;
  const failedCount = timeline.filter((t) => t.tone === 'failed').length;

  const wsActive = !!(realStatus.websocket_connected || summary?.websocket_connected || summary?.websocket?.connected);
  const sessionActive = !!(realStatus.session_active || summary?.session_active || summary?.session?.active);

  const op: 'running' | 'degraded' | 'stopped' =
    state === 'ERROR' || failedCount > 0 ? 'stopped'
      : wsActive || sessionActive || doneCount > 0 ? 'running' : 'stopped';
  void op;

  const hasAnyError = !!(engineError || statusError || readinessError || summaryError || historyError);
  const combinedError = [
    engineError && `Engine: ${engineError}`,
    statusError && `Status: ${statusError}`,
    readinessError && `Readiness: ${readinessError}`,
    summaryError && `Summary: ${summaryError}`,
    historyError && `History: ${historyError}`,
  ].filter(Boolean).join(' · ');

  const countdown = liveCountdown(nextAt, nextEvent?.remaining_seconds, now);
  const lastAgo = lastRun?.actual_at
    ? fmtAgo(new Date(lastRun.actual_at).getTime(), now)
    : '—';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Scheduler Engine"
        subtitle={`IST lifecycle controller · ${summary?.business_date ?? '—'} · ${isTradingDay === null ? 'calendar loading…' : isTradingDay ? 'trading day' : 'not a trading day'} · all values live from backend`}
      >
        <StatusBadge status={connected ? 'success' : 'danger'} label={connected ? 'LIVE' : 'OFFLINE'} />
        {stale && <StatusBadge status="warning" label="STALE" />}
        <Badge variant="outline" className="hidden font-mono text-[10px] sm:inline-flex">
          {fmtClockIST(new Date(now).toISOString())} IST
        </Badge>
        <Link href="/services/scheduler/settings">
          <Button size="sm" variant="outline"><Settings2 className="mr-1 h-3 w-3" /> Settings</Button>
        </Link>
        <Button size="sm" variant="outline" onClick={reload}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </PageHeader>

      {hasAnyError && <ErrorState message={combinedError} onRetry={reload} />}
      {loading && !engine && !status && !summary && <LoadingState text="Loading Scheduler Engine…" />}

      {/* ── Now / Next hero — 1s ticking ─────────────────────────────── */}
      <div className="grid gap-3 lg:grid-cols-3">
        <SectionCard title="Abhi kya hai (Now)" icon={Activity} className="shadow-soft lg:col-span-1">
          <div className="space-y-2 text-xs">
            <div className="flex items-center gap-2">
              {state
                ? <Badge variant="outline" className={LIFECYCLE_TONE[state] ?? ''}>{state}</Badge>
                : <Badge variant="outline">—</Badge>}
              {phase && <Badge variant="outline" className="bg-sky-500/10 text-sky-300">PHASE {String(phase)}</Badge>}
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">Session</span><span className={`font-mono ${sessionActive ? 'text-emerald-300' : ''}`}>{sessionActive ? 'ACTIVE' : 'INACTIVE'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Feed (WS)</span><span className={`font-mono ${wsActive ? 'text-emerald-300' : ''}`}>{wsActive ? 'CONNECTED' : 'DISCONNECTED'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Market</span><span className="font-mono">{realStatus.market_status ?? status?.marketStatus ?? summary?.market_state ?? '—'}</span></div>
            <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Last event (hua kya)</div>
              {lastRun ? (
                <>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{lastRun.job_id ?? '—'}</span>
                    <Badge variant="outline" className={(RUN_VIEW[lastRun.status] as any)?.tone ?? ''}>{(RUN_VIEW[lastRun.status] as any)?.label ?? lastRun.status ?? '—'}</Badge>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">{fmtDateTimeIST(lastRun.actual_at)} IST · {lastAgo} pehle</div>
                </>
              ) : (
                <div className="mt-1 text-muted-foreground">Abhi tak koi event record nahi hua.</div>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Aage kya hai (Next)" icon={Timer} className="shadow-soft lg:col-span-1" headerRight={<Badge variant="outline" className="font-mono">{countdown}</Badge>}>
          <div className="space-y-2 text-xs">
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Next event</div>
              <div className="mt-1 font-mono text-lg font-semibold">{nextLabel ?? (isTradingDay === false ? 'NOT APPLICABLE' : '—')}</div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {nextAt ? `${fmtDateTimeIST(nextAt)} IST · ${countdown} me` : 'Backend se next event available nahi'}
              </div>
            </div>
            <div className="flex justify-between"><span className="text-muted-foreground">Progress (aaj)</span><span className="font-mono">{doneCount}/{timeline.length} done{failedCount > 0 ? ` · ${failedCount} failed` : ''}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${timeline.length ? Math.round((doneCount / timeline.length) * 100) : 0}%` }} />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link href="/services/scheduler/lifecycle" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Full lifecycle <ArrowRight className="h-3 w-3" /></Link>
              <Link href="/services/scheduler/timeline" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Timeline <ArrowRight className="h-3 w-3" /></Link>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Live ticks (realtime)"
          icon={Radio}
          className="shadow-soft lg:col-span-1"
          headerRight={<StatusBadge status={connected ? 'success' : 'danger'} label={connected ? `${liveEvents.length} events` : 'no stream'} />}
        >
          {liveEvents.length === 0 ? (
            <EmptyState icon={Radio} title={connected ? 'Stream connected — events ka wait' : 'Stream offline'} description={connected ? 'Scheduler jab event karega, yahan realtime tick aayega.' : 'Backend /api/schedule-events/stream se connect nahi ho paya.'} />
          ) : (
            <div className="max-h-56 space-y-1.5 overflow-auto pr-1">
              {liveEvents.map((e, i) => (
                <div key={`${e.receivedAt}-${i}`} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${i === 0 ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-border/50 bg-muted/20'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono font-medium">{e.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtClockIST(new Date(e.receivedAt).toISOString())}</span>
                  </div>
                  {e.detail && <div className="truncate font-mono text-[10px] text-muted-foreground">{e.detail}</div>}
                </div>
              ))}
            </div>
          )}
          <p className="pt-2 text-[10px] text-muted-foreground">Source: backend SSE · har tick par data auto-refresh hota hai.</p>
        </SectionCard>
      </div>

      {/* ── Stats ───────────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={CalendarDays} title="State" value={state ?? '—'} sub={`Phase ${phase ?? '—'} · ${status?.sessionOwner ? `owner ${status.sessionOwner}` : 'no owner'}`} tone={wsActive || sessionActive ? 'success' : 'neutral'} />
        <StatCard icon={ShieldCheck} title="Readiness (§6)" value={readinessOverall ?? '—'} sub={critical.length ? `Critical ${readyCount}/${critical.length}` : 'checks unavailable'} tone={readinessOverall === 'READY' ? 'success' : readinessOverall === 'NOT_READY' ? 'danger' : 'neutral'} />
        <StatCard icon={ListChecks} title="Runs today" value={fmtNum(summary?.today?.total)} sub={`${fmtNum(summary?.today?.completed)} done · ${fmtNum(summary?.today?.failed)} failed`} tone={Number(summary?.today?.failed) > 0 ? 'danger' : 'success'} />
        <StatCard icon={Clock4} title="Missed / Waiting" value={`${fmtNum(summary?.today?.missed)} / ${fmtNum(summary?.today?.waiting)}`} sub={`expired +${fmtNum(summary?.today?.missed_expired)} · due ${fmtClockIST(nextAt)}`} tone={Number(summary?.today?.missed) > 0 ? 'warning' : 'neutral'} />
      </div>

      {/* ── Aaj ka event flow ───────────────────────────────────────── */}
      <SectionCard
        title="Aaj ka event flow (scheduler lifecycle)"
        icon={Zap}
        className="shadow-soft"
        headerRight={<Link href="/services/scheduler/lifecycle" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Detail lifecycle <ExternalLink className="h-3 w-3" /></Link>}
      >
        <div className="flex flex-col gap-1.5 md:flex-row md:items-stretch">
          {timeline.map((t, i) => (
            <div key={t.key} className="flex flex-1 items-stretch gap-1.5">
              <div className={`flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-2 ${toneBox(t.tone)}`}>
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-semibold">{t.label}</span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${toneDot(t.tone)}`} />
                </div>
                <span className="font-mono text-[11px]">{t.scheduledAt ? fmtHHMM(t.scheduledAt) : '—'}</span>
                <span className="truncate font-mono text-[9px] opacity-70">{t.run?.status ?? t.displayStatus}</span>
              </div>
              {i < timeline.length - 1 && <div className="hidden w-px self-stretch bg-border/60 md:block" />}
            </div>
          ))}
        </div>
        <p className="pt-2 text-[10px] text-muted-foreground">Scheduled time = backend calendar · status = persisted run record (scheduler_runs) · green = ho gaya, blue/pulse = chal raha, amber = wait, red = fail/miss.</p>
      </SectionCard>

      {/* ── Recent history preview ──────────────────────────────────── */}
      <SectionCard
        title="Recent history"
        icon={History}
        className="shadow-soft"
        headerRight={<div className="flex items-center gap-2"><Badge variant="outline">{fmtNum(ledgerRows.length)}</Badge><Link href="/services/scheduler/history" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Full history <ExternalLink className="h-3 w-3" /></Link></div>}
      >
        {ledgerRows.length === 0 ? (
          <EmptyState icon={ListChecks} title="No runs recorded" description="Aaj ka koi scheduler run persist nahi hua." />
        ) : (
          <div className="max-h-72 overflow-auto rounded-lg border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1">Job</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Scheduled</th>
                  <th className="px-2 py-1">Actual (IST)</th>
                  <th className="px-2 py-1">Reason</th>
                </tr>
              </thead>
              <tbody>
                {ledgerRows.slice(0, 8).map((r: any, i: number) => (
                  <tr key={r.execution_id ?? r._id ?? r.run_id ?? i} className="border-t">
                    <td className="px-2 py-1 font-medium">{r.job_id ?? r.jobId ?? '—'}</td>
                    <td className="px-2 py-1"><Badge variant="outline" className={(RUN_VIEW[r.status] as any)?.tone ?? ''}>{(RUN_VIEW[r.status] as any)?.label ?? r.status ?? '—'}</Badge></td>
                    <td className="px-2 py-1 font-mono">{fmtHHMM(r.scheduled_at ?? r.scheduledAt)}</td>
                    <td className="px-2 py-1 font-mono">{fmtTs(r.actual_at ?? r.completed_at ?? r.started_at)}</td>
                    <td className="max-w-[16rem] truncate px-2 py-1 font-mono text-[10px] text-muted-foreground">{r.reason ?? r.reason_code ?? r.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* ── Readiness compact ───────────────────────────────────────── */}
      <SectionCard
        title="Readiness (spec §6) — compact"
        icon={CheckCircle2}
        className="shadow-soft"
        headerRight={<div className="flex items-center gap-2"><Badge variant="outline">{checks.length ? fmtNum(checks.length) : '—'}</Badge><Link href="/services/scheduler/timeline" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">Full report <ExternalLink className="h-3 w-3" /></Link></div>}
      >
        {checks.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No checks" description="Readiness checks abhi available nahi (non-trading day ho sakta hai)." />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {checks.slice(0, 12).map((c: any, i: number) => (
              <Badge key={c.component ?? i} variant="outline" className={c.ready ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/30 bg-rose-500/10 text-rose-200'}>
                {c.component ?? '—'}: {c.ready ? 'READY' : 'NOT READY'}
              </Badge>
            ))}
            {checks.length > 12 && <Badge variant="outline">+{checks.length - 12} more</Badge>}
          </div>
        )}
        <p className="pt-2 font-mono text-[10px] text-muted-foreground">Next tick collection: {fmtRemaining(nextEvent?.remaining_seconds ?? status?.remainingSeconds)} · phase {String(phase ?? '—')} · {fmtTs(status?.currentTime ?? summary?.current_time_ist)}</p>
      </SectionCard>
    </div>
  );
}

function toneBox(tone: string): string {
  switch (tone) {
    case 'done': return 'border-emerald-500/30 bg-emerald-500/10';
    case 'active': return 'border-sky-500/40 bg-sky-500/10';
    case 'failed': return 'border-rose-500/40 bg-rose-500/10';
    case 'missed': return 'border-amber-500/40 bg-amber-500/10';
    case 'upcoming': return 'border-slate-500/25 bg-slate-500/5';
    default: return 'border-border/50 bg-muted/20 opacity-70';
  }
}

function toneDot(tone: string): string {
  switch (tone) {
    case 'done': return 'bg-emerald-400';
    case 'active': return 'bg-sky-400 animate-pulse';
    case 'failed': return 'bg-rose-400';
    case 'missed': return 'bg-amber-400';
    case 'upcoming': return 'bg-slate-400';
    default: return 'bg-slate-600';
  }
}

function fmtAgo(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return '—';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

void fmtRemaining;
