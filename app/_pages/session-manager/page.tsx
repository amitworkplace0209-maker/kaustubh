'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Cable,
  Cpu,
  Database,
  Filter,
  History as HistoryIcon,
  Layers,
  Pin as PinIcon,
  Radio,
  RefreshCw,
  ShieldCheck,
  Timer,
  Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import {
  SM, TONE, fmtNum, fmtTs, fmtDuration,
} from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Overview — fast + full color.
 *
 * SPEED FIX (slow-load root causes):
 *  - /subscriptions dropped (it re-downloads the full ~2.7k registry that
 *    /overview already ships — counts now come from overview.counts).
 *  - Secondary panels (diagnostics/expiry/connections/events) mount 600ms
 *    AFTER first paint so hero + KPIs paint instantly.
 *  - WS#2 cadence refresh is throttled (overview/session 15s, secondary 30s,
 *    hidden-tab paused) instead of refetching everything on every frame.
 *  - IST clock is isolated in its own component (was re-rendering the whole
 *    page every second).
 *
 * Real data only — missing backend state renders as '—'/skeleton, never fake.
 */

const SM_OVERVIEW = `${SM}/overview`;
const SM_SESSION = `${SM}/session`;
const SM_DIAG = `${SM}/diagnostics`;
const SM_EXPIRY = `${SM}/expiry`;
const SM_CONNS = `${SM}/connections`;
const SM_EVENTS = `${SM}/events?limit=20`;

const DONUT_COLORS: Record<string, string> = {
  ACTIVE: '#34d399',
  SUBSCRIBED: '#22d3ee',
  SUBSCRIBED_AND_PINNED: '#fbbf24',
  PINNED_ONLY: '#f59e0b',
  EXPIRING: '#facc15',
  EXPIRED: '#fb7185',
  INACTIVE: '#71717a',
  UNSUBSCRIBED: '#64748b',
  NOT_SUBSCRIBED: '#64748b',
};

/** Throttled WS#2 cadence: at most 1 refresh per delayMs, paused when tab hidden. */
function useThrottledCadence(refresh: () => void, active: boolean, delayMs: number) {
  const { onFrame } = useFrontendRealtime();
  const last = useRef(0);
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    if (!active) return;
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < delayMs) return;
      last.current = t;
      fn.current();
    });
  }, [onFrame, active, delayMs]);
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Badge variant="outline" className="tabular-nums">
      IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}
    </Badge>
  );
}

// ---------------- colorful KPI ----------------
type Accent = 'emerald' | 'cyan' | 'violet' | 'amber' | 'rose' | 'sky';
const ACCENT: Record<Accent, { bar: string; chip: string; value: string }> = {
  emerald: { bar: 'bg-emerald-400', chip: 'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/25', value: 'text-emerald-300' },
  cyan: { bar: 'bg-cyan-400', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-lg shadow-cyan-500/25', value: 'text-cyan-300' },
  violet: { bar: 'bg-violet-400', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25', value: 'text-violet-300' },
  amber: { bar: 'bg-amber-400', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25', value: 'text-amber-300' },
  rose: { bar: 'bg-rose-400', chip: 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-lg shadow-rose-500/25', value: 'text-rose-300' },
  sky: { bar: 'bg-sky-400', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg shadow-sky-500/25', value: 'text-sky-300' },
};

function Kpi({ icon: Icon, label, value, sub, accent, loading }: {
  icon: React.ElementType; label: string; value: string; sub?: string; accent: Accent; loading?: boolean;
}) {
  const a = ACCENT[accent];
  return (
    <Card className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', a.bar)} />
      <span aria-hidden className={cn('pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-20 blur-2xl', a.bar)} />
      <CardContent className="relative flex items-center gap-3 p-3.5">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', a.chip)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          {loading ? (
            <div className="mt-1 h-7 w-20 animate-pulse rounded bg-muted/70" />
          ) : (
            <p className={cn('truncate font-mono text-xl font-bold tabular-nums leading-7', a.value)} title={value}>{value}</p>
          )}
          <p className="truncate text-[11px] text-muted-foreground" title={sub}>{sub ?? ' '}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- donut + bars (real statusCounts) ----------------
function StatusDonut({ counts }: { counts: Record<string, number> }) {
  const entries = useMemo(
    () => Object.entries(counts ?? {}).filter(([, v]) => Number(v) > 0).sort((a, b) => Number(b[1]) - Number(a[1])),
    [counts],
  );
  const total = entries.reduce((s, [, v]) => s + Number(v), 0);
  if (!total) return <div className="flex h-44 items-center justify-center text-xs text-muted-foreground">No status data yet — backend ne koi record nahi bheja.</div>;
  let acc = 0;
  const stops = entries.map(([k, v]) => {
    const from = (acc / total) * 360;
    acc += Number(v);
    const to = (acc / total) * 360;
    return `${DONUT_COLORS[k] ?? '#38bdf8'} ${from}deg ${to}deg`;
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
        <div className="relative h-44 w-44 shrink-0 rounded-full ring-4 ring-white/5 transition-transform duration-200 hover:scale-[1.03]" style={{ background: `conic-gradient(${stops.join(', ')})` }} role="img" aria-label={`${total} instruments by status`}>
          <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-card shadow-inner">
            <span className="font-mono text-2xl font-bold tabular-nums">{fmtNum(total)}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">records</span>
          </div>
        </div>
        <div className="grid w-full flex-1 grid-cols-1 gap-1.5 min-[420px]:grid-cols-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-white/[0.02] px-2.5 py-1.5 text-xs transition-colors hover:border-primary/40">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full shadow" style={{ background: DONUT_COLORS[k] ?? '#38bdf8' }} />
                <span className="truncate font-mono font-medium">{k}</span>
              </span>
              <span className="font-mono font-bold tabular-nums">{fmtNum(v)}</span>
            </div>
          ))}
        </div>
      </div>
      {/* distribution bars — chart */}
      <div className="space-y-1.5">
        {entries.slice(0, 6).map(([k, v]) => {
          const pct = (Number(v) / total) * 100;
          return (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className="w-36 shrink-0 truncate font-mono text-muted-foreground">{k}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/70">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: DONUT_COLORS[k] ?? '#38bdf8' }} />
              </div>
              <span className="w-12 shrink-0 text-right font-mono tabular-nums">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FeedBars({ levels }: { levels: Record<string, number> }) {
  const order = ['L4', 'L8', 'L16', 'UNSET'] as const;
  const colors: Record<string, string> = { L4: '#94a3b8', L8: '#e879f9', L16: '#a78bfa', UNSET: '#52525b' };
  const total = order.reduce((s, k) => s + Number(levels?.[k] ?? 0), 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {order.map((l) => {
        const v = Number(levels?.[l] ?? 0);
        const pct = total ? (v / total) * 100 : 0;
        return (
          <div key={l} className="min-w-[110px] flex-1 rounded-lg border border-border/50 bg-white/[0.02] px-2.5 py-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 font-mono font-bold"><span className="h-2 w-2 rounded-full" style={{ background: colors[l] }} />{l}</span>
              <span className="font-mono tabular-nums">{fmtNum(v)}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/70">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: colors[l] }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- main page ----------------
export default function SessionManagerOverviewPage() {
  // critical first, secondary after paint
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 600);
    return () => clearTimeout(t);
  }, []);

  const ov = useOneShot<Record<string, unknown>>(SM_OVERVIEW);
  const sess = useOneShot<Record<string, unknown>>(SM_SESSION);
  const diag = useOneShot<Record<string, unknown>>(SM_DIAG, late);
  const exp = useOneShot<Record<string, unknown>>(SM_EXPIRY, late);
  const con = useOneShot<Record<string, unknown>>(SM_CONNS, late);
  const evt = useOneShot<unknown[]>(SM_EVENTS, late);

  useThrottledCadence(ov.refresh, true, 15000);
  useThrottledCadence(sess.refresh, true, 15000);
  useThrottledCadence(diag.refresh, late, 30000);
  useThrottledCadence(exp.refresh, late, 30000);
  useThrottledCadence(con.refresh, late, 30000);
  useThrottledCadence(evt.refresh, late, 30000);

  const refreshAll = () => {
    ov.refresh(); sess.refresh();
    if (late) { diag.refresh(); exp.refresh(); con.refresh(); evt.refresh(); }
  };

  const overview = (ov.data ?? {}) as Record<string, any>;
  const session = (sess.data ?? {}) as Record<string, any>;
  const diagnostics = (diag.data ?? {}) as Record<string, any>;
  const expiry = (exp.data ?? {}) as Record<string, any>;
  const connsData = (con.data ?? {}) as Record<string, any>;

  const counts = (overview.counts ?? {}) as Record<string, any>;
  const status = (overview.statusCounts ?? {}) as Record<string, number>;
  const levels = (overview.feedLevelCounts ?? {}) as Record<string, number>;
  const health = (overview.health ?? {}) as Record<string, any>;
  const revApply = (overview.revisionApply ?? {}) as Record<string, any>;

  const id = (session.identity ?? {}) as Record<string, any>;
  const life = (session.lifecycle ?? {}) as Record<string, any>;
  const ws = (session.websocket ?? {}) as Record<string, any>;
  const routing = (session.routing ?? {}) as Record<string, any>;
  const active = (overview.active ?? life.active ?? false) as boolean;

  const mongoConnected = Boolean((diagnostics.mongo as Record<string, any> | undefined)?.connected);
  const cfgState = ((diagnostics.config ?? {}) as Record<string, any>);
  const configPersisted = cfgState.cacheSource === 'mongo';
  const engines = Object.entries((diagnostics.engines ?? {}) as Record<string, any>);
  const revisionDesired = (connsData.revision as Record<string, any> | undefined)?.desired ?? overview.revision;
  const connections: any[] = (connsData.connections ?? overview.connections ?? []) as any[];

  const events = useMemo(() => {
    const a = (Array.isArray(evt.data) ? evt.data : []) as any[];
    const b = (Array.isArray(session.events) ? session.events : []) as any[];
    const merged = [...a, ...b.map((e: any) => ({ ts: e.at ?? e.ts, event: e.event, message: e.message }))];
    const seen = new Set<string>();
    const out: any[] = [];
    for (const e of merged) {
      const key = `${e?.ts ?? ''}|${e?.event ?? ''}|${e?.message ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    out.sort((x, y) => String(y?.ts ?? '').localeCompare(String(x?.ts ?? '')));
    return out.slice(0, 12);
  }, [evt.data, session.events]);

  const expiringPreview: any[] = useMemo(() => {
    const rows = (expiry.rows ?? {}) as Record<string, any[]>;
    return [...(rows.expiring ?? []), ...(rows.today ?? [])].slice(0, 5);
  }, [expiry.rows]);

  const loading = !ov.data && !ov.error;

  const remaining = id.remainingSeconds != null ? Math.max(0, Math.round(Number(id.remainingSeconds))) : null;
  const duration = id.sessionDurationSeconds != null ? Math.max(1, Math.round(Number(id.sessionDurationSeconds))) : null;
  const remainPct = remaining != null && duration != null ? Math.max(0, Math.min(100, (remaining / duration) * 100)) : null;

  const expiryBuckets = ([
    ['Today', expiry.today, 'border-amber-500/30 bg-amber-500/10 text-amber-300'],
    ['N-day', expiry.nday, 'border-sky-500/30 bg-sky-500/10 text-sky-300'],
    ['Custom', expiry.custom, 'border-violet-500/30 bg-violet-500/10 text-violet-300'],
    ['Expiring', expiry.expiring ?? status.EXPIRING, 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300'],
    ['Expired', expiry.expired ?? status.EXPIRED, 'border-rose-500/30 bg-rose-500/10 text-rose-300'],
    ['No expiry', expiry.no_expiry, 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300'],
  ] as const);

  const sections = [
    { href: '/services/session-manager/session', icon: Layers, title: 'Session', desc: 'Identity, lifecycle, terminals', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-sky-500/25', text: 'text-sky-300', count: active ? 'ACTIVE' : String(life.lifecycleState ?? life.state ?? '—') },
    { href: '/services/session-manager/instruments', icon: Database, title: 'Instruments', desc: 'Canonical records + actions', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-emerald-500/25', text: 'text-emerald-300', count: `${fmtNum(counts.total)} records` },
    { href: '/services/session-manager/connections', icon: Cable, title: 'Connections', desc: 'Feed links + revisions', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-amber-500/25', text: 'text-amber-300', count: `${fmtNum(connections.length)} links · rev ${fmtNum(revisionDesired)}` },
    { href: '/services/session-manager/sources', icon: Filter, title: 'Sources', desc: 'Instruments by origin', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-violet-500/25', text: 'text-violet-300', count: 'by origin' },
    { href: '/services/session-manager/history', icon: HistoryIcon, title: 'History', desc: 'Lifecycle audit trail', chip: 'bg-gradient-to-br from-slate-500 to-zinc-600 text-white shadow-slate-500/25', text: 'text-slate-300', count: `${fmtNum(events.length)} recent` },
    { href: '/services/session-manager/diagnostics', icon: Cpu, title: 'Diagnostics', desc: 'Health, registry, mongo', chip: 'bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-teal-500/25', text: 'text-teal-300', count: health.ok ? 'HEALTHY' : 'CHECK' },
  ];

  return (
    <div className="space-y-4 pb-6">
      {/* HERO — full color */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.12] via-primary/[0.07] to-emerald-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-violet-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-primary to-emerald-500 text-white shadow-xl">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate bg-gradient-to-r from-foreground via-foreground to-muted-foreground bg-clip-text text-xl font-bold tracking-tight sm:text-2xl">Session Manager</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Broker session + instrument registry control plane · <span className="font-mono font-semibold text-foreground">{fmtNum(counts.total)}</span> instruments · live backend state
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={active ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-200' : 'border border-rose-500/40 bg-gradient-to-r from-rose-500/25 to-rose-500/10 text-rose-200'}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', active ? 'animate-pulse bg-emerald-400' : 'bg-rose-400')} />
              {active ? 'SESSION ACTIVE' : 'NO SESSION'}
            </Badge>
            <Badge variant="outline" className={ws.state === 'CONNECTED' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : ''}>
              WS {String(ws.state ?? '—')}
            </Badge>
            <Badge variant="outline" className={configPersisted ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}>
              {configPersisted ? 'CONFIG PERSISTED' : 'CONFIG DEFAULTS'}
            </Badge>
            <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 tabular-nums text-violet-300">rev {fmtNum(revisionDesired)}</Badge>
            <IstClock />
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-primary to-violet-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        <div className="relative flex h-2 w-full overflow-hidden bg-muted/60">
          {(() => {
            const total = Number(counts.total ?? 0);
            if (!total) return null;
            const a = (Number(status.ACTIVE ?? 0) / total) * 100;
            const e = (Number(status.EXPIRED ?? 0) / total) * 100;
            const x = (Number(status.EXPIRING ?? 0) / total) * 100;
            const s = (Number(status.SUBSCRIBED ?? 0) / total) * 100;
            return (
              <>
                <span className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all" style={{ width: `${a}%` }} />
                <span className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 transition-all" style={{ width: `${s}%` }} />
                <span className="h-full bg-gradient-to-r from-amber-500 to-yellow-400 transition-all" style={{ width: `${x}%` }} />
                <span className="h-full bg-gradient-to-r from-rose-500 to-rose-400 transition-all" style={{ width: `${e}%` }} />
              </>
            );
          })()}
        </div>
      </div>

      {ov.error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0">Backend overview unavailable: {ov.error} — baaki cards jahan data mila wahan real values, kahin fake nahi.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => ov.refresh()}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP — full color cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi accent="emerald" icon={Database} label="Instruments" value={fmtNum(counts.total)} sub={`broker ${String(overview.broker ?? id.broker ?? '—')}`} loading={loading} />
        <Kpi accent="cyan" icon={Zap} label="Active feeding" value={fmtNum(status.ACTIVE)} sub={`${fmtNum(counts.subscribed)} broker-subscribed`} loading={loading} />
        <Kpi accent="violet" icon={Radio} label="Desired" value={fmtNum(counts.desired)} sub={`revision ${fmtNum(revisionDesired)}`} loading={loading} />
        <Kpi accent="amber" icon={PinIcon} label="Pinned" value={fmtNum(counts.pinned)} sub={`${fmtNum(status.SUBSCRIBED_AND_PINNED ?? 0)} sub-pinned`} loading={loading} />
        <Kpi accent="rose" icon={Timer} label="Expired / Expiring" value={`${fmtNum(status.EXPIRED ?? expiry.expired ?? 0)} / ${fmtNum(status.EXPIRING ?? expiry.expiring ?? 0)}`} sub="wall-clock real expiry" loading={loading} />
        <Kpi accent="sky" icon={Activity} label="Health" value={health.ok ? 'HEALTHY' : ov.data ? 'DEGRADED' : '—'} sub={((health.reasons ?? []) as string[])[0] ?? (ov.data ? 'no problems reported' : 'waiting for backend')} loading={loading} />
      </div>

      {/* EXPIRY BUCKETS — colorful chart cards */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {expiryBuckets.map(([label, v]) => (
          <div key={label} className={cn('rounded-xl border px-2.5 py-2.5 text-center shadow-sm transition-transform hover:-translate-y-0.5', label === 'Today' && 'border-amber-500/30 bg-gradient-to-b from-amber-500/15 to-transparent', label === 'N-day' && 'border-sky-500/30 bg-gradient-to-b from-sky-500/15 to-transparent', label === 'Custom' && 'border-violet-500/30 bg-gradient-to-b from-violet-500/15 to-transparent', label === 'Expiring' && 'border-yellow-500/30 bg-gradient-to-b from-yellow-500/15 to-transparent', label === 'Expired' && 'border-rose-500/30 bg-gradient-to-b from-rose-500/15 to-transparent', label === 'No expiry' && 'border-zinc-500/30 bg-gradient-to-b from-zinc-500/15 to-transparent')}>
            <p className="font-mono text-lg font-bold tabular-nums">{exp.error && expiry.today == null ? '—' : fmtNum(v as number | undefined)}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      {/* MAIN GRID */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="overflow-hidden shadow-soft lg:col-span-3">
          <CardHeader className="bg-gradient-to-r from-violet-500/10 via-primary/5 to-emerald-500/10 pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
              Status mix · live registry chart
              <Badge variant="outline" className="ml-auto tabular-nums">rev {fmtNum(revisionDesired)} · {revApply.fully_applied ? 'applied' : 'pending'}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {loading ? (
              <div className="flex h-44 items-center justify-center"><div className="h-32 w-32 animate-pulse rounded-full bg-gradient-to-br from-muted to-muted/50" /></div>
            ) : (
              <StatusDonut counts={status} />
            )}
            <div className="mt-4 border-t border-border/50 pt-3">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Feed levels</p>
              <FeedBars levels={levels} />
              <p className="mt-2 text-right text-[11px] text-muted-foreground">updated {fmtTs(overview.lastUpdatedAt as string | undefined)}</p>
            </div>
          </CardContent>
        </Card>

        {/* Session identity */}
        <Card className="overflow-hidden shadow-soft lg:col-span-2">
          <CardHeader className="bg-gradient-to-r from-emerald-500/10 via-cyan-500/5 to-sky-500/10 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 p-1.5 text-white shadow"><ShieldCheck className="h-3.5 w-3.5" /></span>
              Live session
              <Badge variant="outline" className={cn('ml-auto', active && 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200')}>{String(life.lifecycleState ?? life.state ?? '—')}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-4 text-xs">
            {!sess.data && !sess.error ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-gradient-to-r from-muted/70 to-muted/40" />)}</div>
            ) : sess.error ? (
              <p className="text-rose-300">Session load failed: {sess.error}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-sky-500/25 bg-gradient-to-b from-sky-500/10 to-transparent px-2.5 py-2"><p className="text-[10px] font-bold uppercase tracking-wider text-sky-300/80">Broker</p><p className="truncate font-mono font-semibold">{String(id.broker ?? overview.broker ?? '—')}</p></div>
                  <div className="rounded-xl border border-violet-500/25 bg-gradient-to-b from-violet-500/10 to-transparent px-2.5 py-2"><p className="text-[10px] font-bold uppercase tracking-wider text-violet-300/80">Mode · source</p><p className="truncate font-mono font-semibold">{String(id.mode ?? overview.mode ?? '—')} · {String(id.loginSource ?? '—')}</p></div>
                </div>
                <div className="rounded-xl border border-emerald-500/25 bg-gradient-to-b from-emerald-500/10 to-transparent px-2.5 py-2">
                  <div className="flex items-center justify-between"><p className="text-[10px] font-bold uppercase tracking-wider text-emerald-300/80">Remaining</p><p className="font-mono font-bold tabular-nums">{remaining != null ? fmtDuration(remaining) : '—'}</p></div>
                  {remainPct != null && (
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full bg-gradient-to-r transition-all', remainPct > 30 ? 'from-emerald-500 to-emerald-400' : 'from-amber-500 to-amber-400')} style={{ width: `${remainPct}%` }} /></div>
                  )}
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">login {fmtTs(id.loginTime as string | undefined)} → exp {fmtTs(id.expiresAt as string | undefined)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className={ws.state === 'CONNECTED' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : ''}>WS {String(ws.state ?? '—')}</Badge>
                  <Badge variant="outline" className="tabular-nums">reconnects {fmtNum(ws.reconnectCount)}</Badge>
                  <Badge variant="outline">routing {String(routing.state ?? '—')}</Badge>
                </div>
                <div className="space-y-0.5 text-[11px] text-muted-foreground">
                  <p className="truncate">user <span className="font-mono text-foreground">{String(id.userId ?? '—')}</span> · validated {fmtTs(id.validatedAt as string | undefined)}</p>
                  <p className="truncate">last activity {fmtTs(session.lastActivityAt as string | undefined)} · last msg {fmtTs(ws.lastMessageAt as string | undefined)}</p>
                  {(session.lastAuthError as string | undefined) && <p className="truncate text-rose-300">auth err: {String(session.lastAuthError)}</p>}
                  {(session.lastRestError as string | undefined) && <p className="truncate text-rose-300">rest err: {String(session.lastRestError)}</p>}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* SECOND ROW */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><Timer className="h-3.5 w-3.5" /></span>
              Expiring soon
              <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(expiry.expiring ?? status.EXPIRING)} live</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-3">
            {!late || (!exp.data && !exp.error) ? (
              <div className="space-y-1.5">{[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/60" />)}</div>
            ) : (
              <>
                {expiringPreview.map((r: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-2 py-1.5 text-[11px]">
                    <span className="min-w-0 truncate font-medium">{r.symbol || '—'} <span className="font-mono text-muted-foreground">{r.instrument_token}</span></span>
                    <span className="shrink-0 font-mono text-muted-foreground">{fmtTs(r.expires_at)}</span>
                  </div>
                ))}
                {!expiringPreview.length && <p className="py-3 text-center text-[11px] text-muted-foreground">{exp.error ? `Expiry unavailable: ${exp.error}` : 'Koi expiring instrument nahi — registry clean hai.'}</p>}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-sky-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 p-1.5 text-white shadow"><Cable className="h-3.5 w-3.5" /></span>
              Connections · rev {fmtNum(revisionDesired)}
              <Link href="/services/session-manager/connections" className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-primary">open <ArrowUpRight className="h-3 w-3" /></Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {!late || (!con.data && !con.error) ? (
              <div className="space-y-1.5">{[0, 1].map((i) => <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/60" />)}</div>
            ) : con.error ? (
              <p className="text-xs text-rose-300">Connections unavailable: {con.error}</p>
            ) : connections.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No feed connections — backend ne koi link report nahi kiya.</p>
            ) : (
              connections.slice(0, 4).map((c: any) => (
                <div key={c.connection_id ?? c.id} className={cn('rounded-lg border px-2.5 py-2', c.state === 'CONNECTED' ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-rose-500/25 bg-rose-500/[0.05]')}>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="font-mono font-semibold">{c.connection_id ?? c.id}</span>
                    <Badge variant="outline" className={c.state === 'CONNECTED' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-rose-500/40 bg-rose-500/15 text-rose-200'}>{String(c.state ?? '—')}</Badge>
                    <span className="ml-auto font-mono text-muted-foreground">rev {fmtNum(c.last_applied_revision)}</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">broker {c.broker ?? '—'} · hb {fmtTs(c.last_heartbeat)} · reconnects {fmtNum(c.reconnect_count)}</p>
                </div>
              ))
            )}
            <p className="pt-1 text-[11px] text-muted-foreground">fully applied: <span className={cn('font-mono font-semibold', revApply.fully_applied ? 'text-emerald-300' : 'text-amber-300')}>{String(revApply.fully_applied ?? '—')}</span></p>
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-fuchsia-500/10 to-pink-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-600 p-1.5 text-white shadow"><HistoryIcon className="h-3.5 w-3.5" /></span>
              Live lifecycle events
              <Link href="/services/session-manager/history" className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-primary">open <ArrowUpRight className="h-3 w-3" /></Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="max-h-[260px] space-y-1 overflow-y-auto">
              {!late || (!evt.data && !evt.error && !session.events) ? (
                <div className="space-y-1.5">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 animate-pulse rounded-lg bg-muted/60" />)}</div>
              ) : (
                <>
                  {events.map((e: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 rounded-lg border border-border/40 bg-white/[0.02] px-2 py-1.5 text-[11px]">
                      <Badge variant="outline" className={cn('shrink-0 font-mono text-[9px]', TONE[e.severity ?? ''] ?? 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300')}>{String(e.event ?? 'event').toUpperCase().slice(0, 18)}</Badge>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.message ?? e.details ?? e.instrument_id ?? '—'}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTs(e.ts ?? e.timestamp ?? e.created_at ?? e.at)}</span>
                    </div>
                  ))}
                  {!events.length && <p className="py-4 text-center text-[11px] text-muted-foreground">{evt.error ? `Events unavailable: ${evt.error}` : 'Abhi koi lifecycle event nahi.'}</p>}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* DIAGNOSTICS STRIP */}
      <Card className="border-dashed shadow-soft">
        <CardContent className="flex flex-wrap items-center gap-2 p-3 text-xs">
          {!late || (!diag.data && !diag.error) ? (
            <div className="h-6 w-full animate-pulse rounded bg-muted/60" />
          ) : (
            <>
              <Badge variant="outline" className={mongoConnected ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-rose-500/40 bg-rose-500/15 text-rose-200'}>
                Mongo {mongoConnected ? 'CONNECTED' : 'DOWN'}
              </Badge>
              {engines.map(([eid, e]: [string, any]) => (
                <Badge key={eid} variant="outline" className={e.state === 'RUNNING' ? 'border-emerald-500/30 text-emerald-300' : ''}>
                  {eid}: {String(e.state ?? '—')}{e.health && e.health !== 'HEALTHY' ? ` · ${e.health}` : ''}
                </Badge>
              ))}
              {!engines.length && <span className="text-muted-foreground">Engine registry: {diag.error ?? '—'}</span>}
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                cache {String(cfgState.cacheSource ?? '—')}
                {diagnostics.lastRestError ? ` · last err: ${diagnostics.lastRestError}` : ''}
              </span>
            </>
          )}
        </CardContent>
      </Card>

      {/* SECTIONS — full color cards */}
      <div>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Cable className="h-4 w-4" /> SECTIONS · live counts ke saath
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((s) => (
            <Link key={s.href} href={s.href}>
              <Card className="group shadow-soft transition-all duration-200 hover:-translate-y-1 hover:border-primary/40 hover:shadow-soft-lg">
                <CardContent className="flex items-center gap-3 p-4">
                  <span className={cn('rounded-xl p-2.5 shadow-lg transition-transform duration-200 group-hover:scale-110', s.chip)}>
                    <s.icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{s.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{s.desc}</span>
                    <span className={cn('mt-0.5 block truncate font-mono text-[10px]', s.text)}>{s.count}</span>
                  </span>
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Sources: <span className="font-mono">GET /overview · /session · /diagnostics · /expiry · /connections · /events</span> — sab real backend state. Critical (overview+session) pehle, baaki 600ms baad; auto-refresh throttled (15s/30s, hidden tab paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
