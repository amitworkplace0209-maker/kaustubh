'use client';

import {
  Activity, AlertTriangle, CheckCircle2, Circle, Clock, Cpu, ExternalLink,
  Loader2, LogOut, RefreshCw, Radio, ServerCrash, ShieldCheck, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  buildSchedulerTimeline, fmtClockIST, fmtDateTimeIST, fmtDuration, fmtHHMM,
  LIFECYCLE_STAGES, LIFECYCLE_TONE, liveCountdown, RUN_VIEW, STATE_OP, STATE_STAGE,
  useLiveSchedulerEvents, useNow, useSchedulerData,
} from './scheduler-data';

const BRIDGE_TONE: Record<string, string> = {
  MARKET_CLOSED: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  LOGGED_OUT: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  LOGIN_PENDING: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  LOGGING_IN: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  LOGGED_IN: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  SESSION_VALID: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  WS_CONNECTING: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  WS_CONNECTED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  WS_DISCONNECTED: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  WS_STOPPING: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  FAILED: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
};

/**
 * SERVICES -> Scheduler -> Lifecycle (redesigned)
 *
 * "Scheduler ne jab-jab jo-jo event kiya" — ek hi vertical lifecycle me:
 *   scheduled time (backend calendar) + actual outcome (persisted run) +
 *   realtime SSE ticks (kaunsa event abhi hua) + next-event countdown (1s tick).
 * Sab real backend data; missing values '—' render hote hain.
 */
export default function Lifecycle() {
  const { status, summary, history, engine, loading, reload } = useSchedulerData();
  const { connected, events: liveEvents, lastMessageAt } = useLiveSchedulerEvents(15);
  const now = useNow(1000);

  const state = status?.schedulerState ?? engine?.state ?? summary?.scheduler_runtime_state ?? null;
  const op = STATE_OP[state] ?? 'stopped';
  const stageIdx = STATE_STAGE[state];
  const dayDone = state === 'MARKET_CLOSED' || state === 'WAITING_FOR_NEXT_TRADING_DAY';
  const phase = status?.phase ?? summary?.phase ?? null;

  const nextEvent = summary?.next_event ?? null;
  const nextAt = status?.nextEventAt ?? nextEvent?.at_ist ?? null;
  const nextLabel = status?.nextEvent ?? nextEvent?.event ?? null;
  const lastRun = summary?.last_event ?? null;

  const timeline = buildSchedulerTimeline({ status, summary, history, now });
  const currentIdx = timeline.findIndex((t) => t.tone === 'active');
  const nextIdx = timeline.findIndex((t) => t.tone === 'upcoming');

  const stale = lastMessageAt != null && now - lastMessageAt > 30_000;
  const opTone =
    op === 'running'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
      : op === 'degraded'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : 'border-rose-500/40 bg-rose-500/10 text-rose-200';
  const opLabel = op === 'running' ? 'RUNNING' : op === 'degraded' ? 'DEGRADED' : 'STOPPED';
  const OpIcon = op === 'running' ? CheckCircle2 : op === 'degraded' ? AlertTriangle : ServerCrash;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold leading-none">Lifecycle</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Har scheduler event — scheduled kab tha, hua kab, status kya raha · realtime ticks ke saath · {fmtClockIST(new Date(now).toISOString())} IST
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={connected ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}>
            <Radio className="mr-1 h-3 w-3" /> {connected ? 'LIVE' : 'OFFLINE'}
          </Badge>
          {stale && <Badge variant="outline" className="bg-amber-500/10 text-amber-300">STALE DATA</Badge>}
          <Button size="sm" variant="outline" onClick={reload}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>
      </div>

      {loading && !status && !summary && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading lifecycle…
        </div>
      )}

      {/* Status banner */}
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${opTone}`}>
        <div className="flex items-center gap-3">
          <OpIcon className="h-6 w-6" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold tracking-wide">{opLabel}</span>
              {state && <Badge variant="outline" className={LIFECYCLE_TONE[state] ?? ''}>{state}</Badge>}
              {phase && <Badge variant="outline" className="bg-sky-500/10 text-sky-300">PHASE {String(phase)}</Badge>}
            </div>
            <div className="mt-0.5 text-xs opacity-90">
              {dayDone ? 'Trading day complete — next trading day ke schedule ka wait.' : `Stage ${stageIdx != null ? stageIdx + 1 : '—'}/${LIFECYCLE_STAGES.length} · ${timeline.filter((t) => t.tone === 'done').length}/${timeline.length} events done`}
            </div>
          </div>
        </div>
        <div className="font-mono text-xs opacity-90">{fmtClockIST(status?.currentTime ?? summary?.current_time_ist)} IST now</div>
      </div>

      {/* Hua kya / Hoga kya — live */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="border-emerald-500/25">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-emerald-300" /> Hua kya (last event)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            {lastRun ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-base font-semibold">{lastRun.job_id ?? '—'}</span>
                  <Badge variant="outline" className={(RUN_VIEW[lastRun.status] as any)?.tone ?? ''}>{(RUN_VIEW[lastRun.status] as any)?.label ?? lastRun.status ?? '—'}</Badge>
                </div>
                <div className="font-mono text-muted-foreground">{fmtDateTimeIST(lastRun.actual_at)} IST</div>
                <div className="font-mono text-[10px] text-muted-foreground">trigger {lastRun.trigger ?? '—'} · {lastRun.reason ?? lastRun.reason_code ?? lastRun.error ?? '—'}</div>
              </>
            ) : (
              <div className="text-muted-foreground">Abhi tak koi persisted event nahi.</div>
            )}
            {status?.lastEvent && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-[11px]">
                <span className="text-muted-foreground">State transition:</span>
                <Badge variant="outline">{status.lastEvent}</Badge>
                <span className="font-mono">{fmtClockIST(status.lastEventTime)} IST</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Zap className="h-4 w-4 text-primary" /> Hoga kya (next event)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div className="font-mono text-base font-semibold">{nextLabel ?? '—'}</div>
            <div className="font-mono text-2xl font-bold text-primary">{liveCountdown(nextAt, nextEvent?.remaining_seconds, now)}</div>
            <div className="font-mono text-muted-foreground">{nextAt ? `${fmtDateTimeIST(nextAt)} IST` : 'Backend se next event nahi mila'}</div>
            {nextIdx >= 0 && <div className="text-[11px] text-muted-foreground">Timeline me agla: <span className="font-mono text-foreground">{timeline[nextIdx]?.label}</span> ({fmtHHMM(timeline[nextIdx]?.scheduledAt)})</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Radio className="h-4 w-4" /> Live ticks ({liveEvents.length})</CardTitle></CardHeader>
          <CardContent>
            {liveEvents.length === 0 ? (
              <div className="py-3 text-center text-[11px] text-muted-foreground">{connected ? 'Events ka wait — scheduler tick karte hi yahan aayega.' : 'Stream offline.'}</div>
            ) : (
              <div className="max-h-44 space-y-1 overflow-auto">
                {liveEvents.slice(0, 6).map((e, i) => (
                  <div key={`${e.receivedAt}-${i}`} className={`rounded border px-2 py-1 text-[11px] ${i === 0 ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-border/50'}`}>
                    <div className="flex justify-between gap-2"><span className="truncate font-mono font-medium">{e.label}</span><span className="font-mono text-[10px] text-muted-foreground">{fmtClockIST(new Date(e.receivedAt).toISOString())}</span></div>
                    {e.detail && <div className="truncate font-mono text-[10px] text-muted-foreground">{e.detail}</div>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Runtime journey stepper */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Activity className="h-4 w-4" /> Runtime journey</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
            {LIFECYCLE_STAGES.map((st, i) => {
              const passed = dayDone || (stageIdx != null && i < stageIdx);
              const isCurrent = !dayDone && stageIdx === i;
              return (
                <div key={st.key} className="flex flex-1 items-center">
                  <div className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 ${isCurrent ? 'border-sky-500/40 bg-sky-500/10' : passed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-slate-500/20 bg-slate-500/5 opacity-60'}`}>
                    {isCurrent ? <Loader2 className="h-4 w-4 animate-spin text-sky-300" /> : passed ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <Circle className="h-4 w-4 text-slate-400" />}
                    <div className="min-w-0"><div className="text-xs font-semibold">{st.label}</div><div className="text-[10px] text-muted-foreground">{i + 1} of {LIFECYCLE_STAGES.length}</div></div>
                  </div>
                </div>
              );
            })}
          </div>
          {dayDone && <div className="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"><LogOut className="h-3.5 w-3.5" /> Day complete · next run next trading-day schedule se.</div>}
        </CardContent>
      </Card>

      {/* Full event lifecycle — vertical */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Clock className="h-4 w-4" /> Full event lifecycle ({timeline.length} events, backend order)</CardTitle></CardHeader>
        <CardContent>
          <div className="relative space-y-0">
            {timeline.map((t, i) => {
              const isLast = i === timeline.length - 1;
              const isCurrent = i === currentIdx;
              return (
                <div key={t.key} className="relative flex gap-3 pb-4 last:pb-0">
                  {!isLast && <div className="absolute bottom-0 left-[15px] top-9 w-px bg-border/70" />}
                  <div className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${dotBox(t.tone)}`}>
                    {iconFor(t.tone)}
                  </div>
                  <div className={`flex-1 rounded-lg border px-3 py-2 ${t.tone === 'active' ? 'border-sky-500/40 bg-sky-500/10' : 'border-border/50 bg-muted/20'}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">{i + 1}. {t.label}</span>
                        <Badge variant="outline" className={badgeTone(t.tone)}>{toneLabel(t)}</Badge>
                        {isCurrent && <Badge variant="outline" className="animate-pulse border-sky-500/40 bg-sky-500/15 text-sky-200">CURRENT</Badge>}
                      </div>
                      <span className="font-mono text-[11px]">sched {t.scheduledAt ? fmtHHMM(t.scheduledAt) : '—'}</span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">{t.hint}{t.jobIds.length ? ` · job ${t.jobIds.join(', ')}` : ' · phase marker (calendar)'}</div>
                    <div className="mt-1.5 grid gap-x-6 gap-y-0.5 font-mono text-[11px] sm:grid-cols-3">
                      <span><span className="text-muted-foreground">Actual: </span>{t.actualAt ? fmtDateTimeIST(t.actualAt) : '—'}</span>
                      <span><span className="text-muted-foreground">Status: </span>{t.run?.status ?? t.displayStatus}</span>
                      <span className="truncate"><span className="text-muted-foreground">Reason: </span>{t.run?.reason ?? t.run?.reason_code ?? t.run?.error ?? '—'}</span>
                    </div>
                    {t.run?.trigger && <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">trigger {t.run.trigger}{t.run?.attempt != null ? ` · attempt ${t.run.attempt}` : ''}{t.run?.duration_ms != null ? ` · ${fmtDuration(t.run.duration_ms)}` : ''}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Brokers */}
      <div className="grid gap-3 sm:grid-cols-2">
        {(status?.enabledBrokers?.length ? status.enabledBrokers : Object.keys(status?.brokers ?? {})).map((br: string) => {
          const rep = status?.brokers?.[br];
          if (!rep) {
            return (
              <div key={br} className="rounded-lg border px-4 py-3 opacity-70">
                <div className="flex items-center gap-2"><Cpu className="h-4 w-4" /><span className="text-sm font-semibold capitalize">{br}</span><Badge variant="outline" className="ml-auto">awaiting first tick</Badge></div>
              </div>
            );
          }
          const brTone = BRIDGE_TONE[rep.state] ?? 'border-slate-500/25 bg-slate-500/5 text-slate-300';
          return (
            <div key={br} className={`rounded-lg border px-4 py-3 ${brTone}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Cpu className="h-4 w-4" /><span className="text-sm font-semibold capitalize">{rep.broker_name ?? br}</span>
                {rep.enabled === false && <Badge variant="outline">disabled</Badge>}
                <Badge variant="outline" className="ml-auto bg-background/40">{rep.state}</Badge>
              </div>
              <div className="mt-1 text-xs opacity-90">{rep.state_message ?? '—'}</div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <span><span className="text-muted-foreground">Login </span><span className="font-mono">{rep.login?.state ?? '—'}</span></span>
                <span><span className="text-muted-foreground">Feed </span><span className="font-mono">{rep.ws?.state ?? '—'}</span></span>
                <span><span className="text-muted-foreground">Session </span><span className="font-mono">{rep.session?.active ? 'active' : 'none'}</span></span>
                <span><span className="text-muted-foreground">Logout </span><span className="font-mono">{rep.logout?.time ?? '—'} IST</span></span>
              </div>
              {rep.oauth?.required && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                  <AlertTriangle className="h-3.5 w-3.5" /><span>OAuth code required.</span>
                  {rep.oauth.url && <a href={rep.oauth.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono underline">open auth URL <ExternalLink className="h-3 w-3" /></a>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4" /> Current state</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {row('State', state, true)}
            {row('Stage', stageIdx != null ? `${stageIdx + 1}. ${LIFECYCLE_STAGES[stageIdx]?.label}` : '—')}
            {row('Phase', phase)}
            {row('Next phase', status?.nextPhase ?? '—', undefined, status?.nextPhaseAt)}
            {row('Session owner', status?.sessionOwner ?? summary?.session_owner ?? 'none')}
            {row('Trading day', status?.isTradingDay ?? summary?.is_trading_day ? 'Yes' : 'No')}
            {row('Market', status?.marketState ?? status?.marketSession ?? summary?.market_state ?? '—')}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Zap className="h-4 w-4" /> What happens next</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {row('Next event', nextLabel ?? '—', undefined, nextAt)}
            {row('Countdown', liveCountdown(nextAt, nextEvent?.remaining_seconds, now), true)}
            {row('Login window', status?.inLoginWindow === true ? 'OPEN' : status?.inLoginWindow === false ? 'closed' : '—', status?.inLoginWindow === true)}
            {row('Feed window', status?.inWsWindow === true ? 'OPEN' : status?.inWsWindow === false ? 'closed' : '—', status?.inWsWindow === true)}
            {row('Next tick collection', status?.nextTickCollection ?? '—')}
            {row('Next logout', status?.nextLogout ?? '—')}
          </CardContent>
        </Card>
      </div>
    </div>
  );

  function row(label: string, value: string | number | null | undefined, highlight?: boolean, at?: string | null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 border-b border-slate-500/10 py-1.5 last:border-0">
        <span className="text-muted-foreground">{label}</span>
        <span className={`flex items-center gap-2 font-mono text-xs ${highlight ? 'text-emerald-200' : ''}`}>
          <span>{value == null || value === '' ? '—' : String(value)}</span>
          {at && <span className="text-muted-foreground">at {fmtClockIST(at)} IST</span>}
        </span>
      </div>
    );
  }
}

function dotBox(tone: string): string {
  switch (tone) {
    case 'done': return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
    case 'active': return 'border-sky-500/50 bg-sky-500/15 text-sky-300';
    case 'failed': return 'border-rose-500/40 bg-rose-500/15 text-rose-300';
    case 'missed': return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
    case 'upcoming': return 'border-slate-500/30 bg-slate-500/10 text-slate-300';
    default: return 'border-border/50 bg-muted/30 text-muted-foreground';
  }
}

function badgeTone(tone: string): string {
  switch (tone) {
    case 'done': return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'active': return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'failed': return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'missed': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'upcoming': return 'bg-slate-500/10 text-slate-300 border-slate-500/25';
    default: return '';
  }
}

function toneLabel(t: { tone: string; run?: any; displayStatus: string }): string {
  if (t.run?.status) return String(t.run.status);
  switch (t.tone) {
    case 'done': return 'DONE';
    case 'active': return 'RUNNING';
    case 'failed': return 'FAILED';
    case 'missed': return 'PENDING';
    case 'upcoming': return 'SCHEDULED';
    default: return t.displayStatus || '—';
  }
}

function iconFor(tone: string) {
  switch (tone) {
    case 'done': return <CheckCircle2 className="h-4 w-4" />;
    case 'active': return <Loader2 className="h-4 w-4 animate-spin" />;
    case 'failed': return <ServerCrash className="h-4 w-4" />;
    case 'missed': return <AlertTriangle className="h-4 w-4" />;
    case 'upcoming': return <Clock className="h-4 w-4" />;
    default: return <Circle className="h-4 w-4" />;
  }
}
