'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, Cpu, Database, Gauge, Layers, MemoryStick,
  Pin as PinIcon, Play, Pause, RefreshCw, RotateCw, Rss, Save, ScrollText,
  Search, Settings2, ShieldCheck, Trash2, Wifi, WifiOff, Workflow, Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  countsByStatus, fieldRowsFiltered, statusShort, statusTone, severityTone,
} from '@/lib/ws-engine';
import { useEngineStatus, useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { cn } from '@/lib/utils';

/**
 * SERVICES → WebSocket Engine — redesigned from zero (advance + fast + full color).
 *
 * WS#1 (Kotak SFeed) single-owner dashboard. Every value is REAL backend state
 * from `/api/phase2/websocket-engine/*` (+ WS#2 realtime for status). Missing
 * renders as '—', never invented.
 *
 * SPEED: tabs fetch LAZY (only the open tab hits the backend) + throttled
 * cadence (active tab max 1/15s, hidden-tab paused). Previously all 12
 * endpoints fetched on mount and EVERY engine.status frame refetched.
 */

const WE = '/api/phase2/websocket-engine';

function fmtNum(n: number | undefined | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

function fmtTime(iso: string | number | null | undefined): string {
  if (iso == null || iso === '') return '—';
  const d = typeof iso === 'number' ? new Date(Number(iso) * 1000) : new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function fmtDateTime(iso: string | number | null | undefined): string {
  if (iso == null || iso === '') return '—';
  const d = typeof iso === 'number' ? new Date(Number(iso) * 1000) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('en-IN')} ${d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}`;
}

function tierBadge(level: number | string | undefined | null) {
  const l = Number(level);
  const label = l === 4 ? 'L4' : l === 8 ? 'L8' : l === 16 ? 'L16' : l ? `L${l}` : 'UNSET';
  const tone =
    label === 'L8' ? 'border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-700'
    : label === 'L16' ? 'border-purple-500/40 bg-purple-500/15 text-purple-700'
    : label === 'L4' ? 'border-slate-500/40 bg-slate-500/10 text-slate-700'
    : 'border-zinc-500/40 bg-zinc-500/10 text-zinc-700';
  return <Badge variant="outline" className={tone}>{label}</Badge>;
}

/** Throttled per-tab cadence — only the OPEN tab refreshes, max 1/delayMs. */
function useTabCadence(refresh: () => void, isActive: boolean, delayMs: number) {
  const { onFrame } = useFrontendRealtime();
  const last = useRef(0);
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    if (!isActive) return;
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < delayMs) return;
      last.current = t;
      fn.current();
    });
  }, [onFrame, isActive, delayMs]);
}

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

/** Live "x ago" ticker — isolated so tables never re-render every second. */
function AgeTicker({ ts }: { ts?: string | number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (ts == null || ts === '') return <span>—</span>;
  const ms = typeof ts === 'number' ? Number(ts) * 1000 : Date.parse(ts);
  if (isNaN(ms)) return <span className="font-mono">{fmtTime(ts)}</span>;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  return <span className="font-mono tabular-nums" title={fmtDateTime(ts)}>{fmtTime(ts)} · {age}</span>;
}

type Accent = 'cyan' | 'emerald' | 'violet' | 'amber' | 'rose' | 'sky' | 'fuchsia' | 'slate';
const ACCENT: Record<Accent, { bar: string; chip: string; value: string }> = {
  cyan: { bar: 'bg-cyan-400', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-lg shadow-cyan-500/25', value: 'text-cyan-700' },
  emerald: { bar: 'bg-emerald-400', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25', value: 'text-emerald-700' },
  violet: { bar: 'bg-violet-400', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25', value: 'text-violet-700' },
  amber: { bar: 'bg-amber-400', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25', value: 'text-amber-700' },
  rose: { bar: 'bg-rose-400', chip: 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-lg shadow-rose-500/25', value: 'text-rose-700' },
  sky: { bar: 'bg-sky-400', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-lg shadow-sky-500/25', value: 'text-sky-300' },
  fuchsia: { bar: 'bg-fuchsia-400', chip: 'bg-gradient-to-br from-fuchsia-500 to-pink-600 text-white shadow-lg shadow-fuchsia-500/25', value: 'text-fuchsia-700' },
  slate: { bar: 'bg-slate-400', chip: 'bg-gradient-to-br from-slate-500 to-zinc-600 text-white shadow-lg shadow-slate-500/25', value: '' },
};

function Kpi({ icon: Icon, label, value, sub, accent, loading }: {
  icon: React.ElementType; label: string; value: React.ReactNode; sub?: string; accent: Accent; loading?: boolean;
}) {
  const a = ACCENT[accent];
  return (
    <Card className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', a.bar)} />
      <CardContent className="flex items-center gap-3 p-3.5">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', a.chip)}><Icon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          {loading ? <div className="mt-1 h-7 w-24 animate-pulse rounded bg-muted/70" /> : <div className={cn('truncate font-mono text-lg font-bold tabular-nums leading-7', a.value)}>{value}</div>}
          <p className="truncate text-[11px] text-muted-foreground">{sub ?? ' '}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function Skeleton({ rows = 3, h = 'h-10' }: { rows?: number; h?: string }) {
  return (
    <div className="space-y-1.5">{Array.from({ length: rows }).map((_, i) => <div key={i} className={cn('animate-pulse rounded-lg bg-muted/60', h)} />)}</div>
  );
}

function TableShell({ head, children, maxH = 'max-h-80' }: { head: React.ReactNode; children: React.ReactNode; maxH?: string }) {
  return (
    <div className={cn('overflow-auto rounded-xl border border-border/60', maxH)}>
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-muted/80 text-muted-foreground backdrop-blur"><tr>{head}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const TH = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={cn('px-2.5 py-2 font-semibold', right && 'text-right')}>{children}</th>
);

/* ------------------------------------------------------------------ */
/* OVERVIEW                                                            */
/* ------------------------------------------------------------------ */
const LIFECYCLE = ['STOPPED', 'STARTING', 'SESSION_CHECK', 'LOADING_SUBSCRIPTIONS', 'CONNECTING', 'CONNECTED', 'SUBSCRIBING', 'LIVE'] as const;

function OverviewPanel({ status, metrics, resources, owner, connected, loading, onRefresh }: any) {
  const ramPct = resources?.ram_percent;
  const severity = resources?.severity ?? 'UNKNOWN';
  const levels = owner?.feed_levels ?? {};
  const realLevels = Object.keys(levels).filter((k) => (levels[k] ?? 0) > 0);
  const totalTicks = realLevels.reduce((s: number, k: string) => s + Number(levels[k] ?? 0), 0);
  const life = owner?.lifecycle_state ?? 'UNKNOWN';
  const lifeIdx = LIFECYCLE.indexOf(life as (typeof LIFECYCLE)[number]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi accent={connected ? 'emerald' : 'slate'} icon={Rss} label="Connector WS#1" loading={loading}
          value={connected ? 'Connected' : status ? 'Disconnected' : '—'}
          sub={`${status?.owner ?? owner?.state ?? '—'} · ${owner?.supervisor_state ?? '—'}`} />
        <Kpi accent="cyan" icon={Gauge} label="Feed" loading={loading}
          value={owner?.feed_state ?? '—'}
          sub={metrics?.ticks_per_second != null ? `${fmtNum(metrics.ticks_per_second)}/s ticks` : realLevels.length ? `${fmtNum(totalTicks)} ticks` : 'no levels'} />
        <Kpi accent="violet" icon={Layers} label="Subscriptions" loading={loading}
          value={fmtNum(status?.subscription_count)}
          sub={`${fmtNum(status?.active_consumers)} consumers · ${fmtNum(status?.active_routes)} routes`} />
        <Kpi accent={severity === 'CRITICAL' ? 'rose' : severity === 'HIGH' || severity === 'WARNING' ? 'amber' : 'sky'} icon={MemoryStick} label="RAM" loading={loading}
          value={ramPct != null ? `${Number(ramPct).toFixed(1)}%` : '—'} sub={severity} />
      </div>

      {/* lifecycle stepper — doc §26 */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-violet-500/10 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-violet-600 p-1.5 text-white shadow"><Zap className="h-3.5 w-3.5" /></span>
            Lifecycle · <span className="font-mono text-foreground">{life}</span>
            <Badge variant="outline" className="ml-auto">feed {owner?.feed_state ?? '—'}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          <div className="flex items-center gap-0 overflow-x-auto pb-1">
            {LIFECYCLE.map((s, i) => {
              const done = lifeIdx >= 0 && i <= lifeIdx;
              const cur = s === life;
              return (
                <div key={s} className="flex min-w-0 flex-1 items-center last:flex-none">
                  <div className="flex min-w-0 flex-col items-center gap-1">
                    <span className={cn('flex h-6 w-6 items-center justify-center rounded-full border text-[9px] font-bold',
                      cur ? 'border-cyan-400 bg-cyan-500/20 text-cyan-700 shadow' : done ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700' : 'border-border text-muted-foreground/50')}>
                      {i + 1}
                    </span>
                    <span className={cn('whitespace-nowrap font-mono text-[8px]', cur ? 'font-bold text-cyan-700' : done ? 'text-emerald-700/80' : 'text-muted-foreground/50')}>{s}</span>
                  </div>
                  {i < LIFECYCLE.length - 1 && <span className={cn('mx-0.5 mb-4 h-px w-4 shrink-0 sm:w-8', done ? 'bg-emerald-500/50' : 'bg-border')} />}
                </div>
              );
            })}
          </div>
          {owner?.disconnect_reason && (
            <p className="mt-1 text-[11px] text-muted-foreground">last disconnect: <span className="font-mono text-foreground">{owner.disconnect_reason}{owner.disconnect_reason_code ? ` (${owner.disconnect_reason_code})` : ''}</span></p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-cyan-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
              Feed levels · ticks
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {realLevels.length === 0 ? <p className="py-3 text-center text-xs text-muted-foreground">No feed levels yet — connect + subscribe first.</p> :
              realLevels.map((k: string) => {
                const v = Number(levels[k] ?? 0);
                const pct = totalTicks ? (v / totalTicks) * 100 : 0;
                const color = k === 'L8' ? '#e879f9' : k === 'L16' ? '#a78bfa' : k === 'L4' ? '#94a3b8' : '#38bdf8';
                return (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    {tierBadge(Number(k.replace('L', '')))}
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/70">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="w-20 shrink-0 text-right font-mono tabular-nums">{fmtNum(v)}</span>
                    <span className="w-12 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
            <div className="flex justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
              <span>msgs total <span className="font-mono text-foreground">{fmtNum(metrics?.messages_total)}</span></span>
              <span>avg latency <span className="font-mono text-foreground">{metrics?.avg_tick_latency_ms != null ? `${Number(metrics.avg_tick_latency_ms).toFixed(1)} ms` : '—'}</span></span>
              <span>last tick <AgeTicker ts={owner?.last_tick_at} /></span>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
              Structure · routing
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              {([['Subscriptions', status?.subscription_count, 'text-violet-700'], ['Desired', status?.desired_subscriptions, ''], ['Consumers', status?.active_consumers, 'text-cyan-700'], ['Routes', status?.active_routes, ''], ['Raw tokens', status?.raw_bucket_tokens, ''], ['Pins', status?.pins, 'text-amber-700'], ['WS id', null, ''], ['Session', null, '']] as const).slice(0, 6).map(([l, v, tone]) => (
                <div key={l} className="rounded-xl border border-border/50 bg-black/[0.03] px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                  <p className={cn('font-mono text-base font-bold tabular-nums', tone)}>{fmtNum(v as number | undefined)}</p>
                </div>
              ))}
            </div>
            <div className="mt-2 space-y-1 rounded-xl border border-border/50 bg-black/[0.03] p-2.5 text-[11px]">
              <p className="flex justify-between"><span className="text-muted-foreground">WS id</span><span className="truncate font-mono" title={owner?.websocket_id}>{owner?.websocket_id ?? '—'}</span></p>
              <p className="flex justify-between"><span className="text-muted-foreground">Session</span><span className="truncate font-mono" title={owner?.session_id}>{owner?.session_id ?? '—'}</span></p>
              <p className="flex justify-between"><span className="text-muted-foreground">Internet</span><span className="font-mono">{owner?.internet_ok == null ? '—' : owner.internet_ok ? 'OK' : 'DOWN'}</span></p>
            </div>
          </CardContent>
        </Card>
      </div>
      <button onClick={onRefresh} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <RefreshCw className="h-3 w-3" /> Refresh overview
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CONNECTION                                                          */
/* ------------------------------------------------------------------ */
function ConnectionPanel({ owner, connected, onAction, busy, result }: any) {
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="overflow-hidden shadow-soft lg:col-span-2">
        <CardHeader className={cn('pb-2', connected ? 'bg-gradient-to-r from-emerald-500/10 to-cyan-500/5' : 'bg-gradient-to-r from-rose-500/10 to-amber-500/5')}>
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className={cn('rounded-lg p-1.5 text-white shadow', connected ? 'bg-gradient-to-br from-emerald-500 to-cyan-600' : 'bg-gradient-to-br from-rose-500 to-amber-600')}>
              {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            </span>
            Control · single WS owner
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy != null} onClick={() => onAction('connect')} className="bg-gradient-to-r from-emerald-500 to-emerald-600"><Play className="mr-1 h-3 w-3" /> Connect</Button>
            <Button size="sm" variant="outline" disabled={busy != null} onClick={() => onAction('reconnect')}><RotateCw className="mr-1 h-3 w-3" /> Reconnect</Button>
            <Button size="sm" variant="destructive" disabled={busy != null} onClick={() => onAction('disconnect')}><Pause className="mr-1 h-3 w-3" /> Disconnect</Button>
            {busy != null && <Badge variant="outline" className="animate-pulse">Executing {busy}…</Badge>}
          </div>
          {result && (
            <p className="text-xs"><span className="text-muted-foreground">{result.action}:</span> {result.ok
              ? <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700">OK</Badge>
              : <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-700">Failed — {result.error}</Badge>}</p>
          )}
          <p className="rounded-xl border border-border/50 bg-black/[0.03] p-2.5 font-mono text-[11px] leading-5">
            {owner?.lifecycle_state ?? 'UNKNOWN'} · {owner?.supervisor_state ?? 'UNKNOWN'} · {owner?.feed_state ?? 'UNKNOWN'}
          </p>
        </CardContent>
      </Card>

      <Card className="overflow-hidden shadow-soft lg:col-span-3">
        <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
            Connection state · real
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Connected at</span><AgeTicker ts={owner?.connected_at} /></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Disconnected at</span><AgeTicker ts={owner?.disconnected_at} /></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Reconnects</span><span className="font-mono tabular-nums">{fmtNum(owner?.reconnect_count)}</span></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Reconnect attempt</span><span className="font-mono tabular-nums">{fmtNum(owner?.reconnect_attempt)}</span></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Subscribed</span><span className="font-mono tabular-nums">{fmtNum(owner?.subscription_count)}</span></p>
            <p className="flex justify-between gap-2"><span className="text-muted-foreground">Messages / ticks</span><span className="font-mono tabular-nums">{fmtNum(owner?.total_messages)} / {fmtNum(owner?.diagnostics?.total_ticks_valid)}</span></p>
          </div>
          {owner?.disconnect_reason && (
            <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-2.5 py-1.5 text-[11px]">reason <span className="font-mono">{owner.disconnect_reason}{owner.disconnect_reason_code ? ` (${owner.disconnect_reason_code})` : ''}</span></p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* LIVE FEED                                                           */
/* ------------------------------------------------------------------ */
function FeedPanel({ live, liveError, loading, onRefresh }: any) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const all = (live?.instruments ?? []) as any[];
    const qq = q.trim().toLowerCase();
    if (!qq) return all;
    return all.filter((r: any) => String(r.symbol ?? '').toLowerCase().includes(qq) || String(r.instrument_token ?? '').includes(qq));
  }, [live?.instruments, q]);
  const maxTps = Math.max(0.01, ...rows.map((r: any) => Number(r.ticks_per_second ?? 0)));

  const exportCsv = () => {
    if (!rows.length) return;
    const head = 'symbol,token,feed,ltp,ticks_per_second,in_window,last_tick\n';
    const body = rows.map((r: any) => [`"${r.symbol ?? ''}"`, `${r.exchange_segment}|${r.instrument_token}`, r.feed_level ?? '', r.ltp ?? '', r.ticks_per_second ?? '', r.ticks_in_window ?? '', r.last_tick_at ?? ''].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ws-live-feed.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-cyan-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
          Live feed · real tick rates
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="tabular-nums">Ticks/s {fmtNum(live?.ticks_per_second)}</Badge>
            <Badge variant="outline" className="tabular-nums">Msgs/s {fmtNum(live?.messages_per_second)}</Badge>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 w-36 pl-7 text-[11px]" />
            </div>
            <Button size="sm" variant="outline" className="h-7" onClick={exportCsv} disabled={!rows.length}>CSV</Button>
            <button onClick={onRefresh} aria-label="Refresh feed" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {liveError ? <p className="py-4 text-center text-sm text-rose-700">Live feed unavailable: {liveError} <button onClick={onRefresh} className="underline">Retry</button></p>
        : loading ? <Skeleton rows={5} />
        : rows.length === 0 ? <p className="py-6 text-center text-xs text-muted-foreground">{q ? `No match for "${q}".` : 'No live ticks yet — connect + subscribe first.'}</p> : (
          <TableShell head={<><TH>Symbol</TH><TH>Token</TH><TH>Feed</TH><TH right>LTP</TH><TH>Rate</TH><TH right>In window</TH><TH>Last tick</TH></>}>
            {rows.map((r: any, i: number) => (
              <tr key={`${r.exchange_segment}|${r.instrument_token}|${i}`} className="border-t border-border/40 transition-colors hover:bg-black/[0.02]">
                <td className="px-2.5 py-1.5 font-medium">{r.symbol || '—'}</td>
                <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{r.exchange_segment}|{r.instrument_token}</td>
                <td className="px-2.5 py-1.5"><span className="flex items-center gap-1">{tierBadge(r.feed_level)}{r.feed_type && <span className="text-[10px] text-muted-foreground">{r.feed_type}</span>}</span></td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.ltp ?? '—'}</td>
                <td className="px-2.5 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted/70"><span className="block h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" style={{ width: `${(Number(r.ticks_per_second ?? 0) / maxTps) * 100}%` }} /></span>
                    <span className="font-mono tabular-nums text-cyan-700">{Number(r.ticks_per_second ?? 0).toFixed(2)}</span>
                  </span>
                </td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.ticks_in_window)}</td>
                <td className="px-2.5 py-1.5"><AgeTicker ts={r.last_tick_at} /></td>
              </tr>
            ))}
          </TableShell>
        )}
        <p className="pt-2 text-[11px] text-muted-foreground">window {live?.window_sec != null ? `${live.window_sec}s` : '—'} · ingested {fmtNum(live?.ingested_total)} · showing {rows.length}</p>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* QUALITY                                                             */
/* ------------------------------------------------------------------ */
function QualityPanel({ quality, qualityError, loading, onRefresh }: any) {
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('ALL');
  const overall = quality?.overall ?? {};
  const lat = overall.latency ?? {};
  const rows = useMemo(() => {
    const all = (quality?.instruments ?? []) as any[];
    const qq = q.trim().toLowerCase();
    return all.filter((r: any) => {
      if (sev !== 'ALL' && String(r.status ?? '').toUpperCase() !== sev) return false;
      if (!qq) return true;
      return String(r.instrument_key ?? '').toLowerCase().includes(qq);
    });
  }, [quality?.instruments, q, sev]);
  const statuses = Object.entries(overall.status_counts ?? {}).filter(([, v]) => Number(v) > 0) as [string, number][];
  const totalSt = statuses.reduce((s, [, v]) => s + Number(v), 0);

  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><Gauge className="h-3.5 w-3.5" /></span>
          Feed quality · monitor
          <span className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter key…" className="h-7 w-36 pl-7 text-[11px]" />
            </div>
            <button onClick={onRefresh} aria-label="Refresh quality" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {qualityError ? <p className="py-3 text-center text-sm text-rose-700">Quality unavailable: {qualityError} <button onClick={onRefresh} className="underline">Retry</button></p>
        : loading ? <Skeleton rows={4} /> : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([['Instruments', overall.instrument_count, ''], ['Msgs/s', overall.messages_per_second, ''], ['Duplicates', overall.duplicate_total, Number(overall.duplicate_total) > 0 ? 'text-amber-700' : ''], ['Seq gaps', overall.sequence_gap_total, Number(overall.sequence_gap_total) > 0 ? 'text-rose-700' : '']] as const).map(([l, v, tone]) => (
                <div key={l} className="rounded-xl border border-border/50 bg-black/[0.03] px-2.5 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                  <p className={cn('font-mono text-base font-bold tabular-nums', tone)}>{fmtNum(v as number | undefined)}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Badge variant="outline" className="tabular-nums">null {fmtNum(overall.null_field_total)}</Badge>
              <Badge variant="outline" className="tabular-nums">invalid {fmtNum(overall.invalid_field_total)}</Badge>
              <Badge variant="outline" className="tabular-nums">p50 {lat.p50 != null ? `${Number(lat.p50).toFixed(1)}ms` : '—'}</Badge>
              <Badge variant="outline" className="tabular-nums">p95 {lat.p95 != null ? `${Number(lat.p95).toFixed(1)}ms` : '—'}</Badge>
              <Badge variant="outline" className="tabular-nums">p99 {lat.p99 != null ? `${Number(lat.p99).toFixed(1)}ms` : '—'}</Badge>
            </div>
            {statuses.length > 0 && (
              <div className="space-y-1">
                {statuses.map(([s, c]) => (
                  <button key={s} onClick={() => setSev(sev === s ? 'ALL' : s)} className="flex w-full items-center gap-2 text-[11px]" title="Filter table">
                    <span className={cn('w-28 shrink-0 truncate text-left font-mono', sev === s && 'font-bold text-foreground')}>{s}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/70">
                      <span className={cn('block h-full rounded-full', s === 'LIVE' ? 'bg-emerald-400' : s === 'STALE' ? 'bg-amber-400' : s === 'NO_FEED' ? 'bg-rose-400' : 'bg-sky-400')} style={{ width: `${(Number(c) / Math.max(1, totalSt)) * 100}%` }} />
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono tabular-nums">{fmtNum(c)}</span>
                  </button>
                ))}
              </div>
            )}
            <TableShell head={<><TH>Instrument</TH><TH>Status</TH><TH right>Msgs</TH><TH right>Dup</TH><TH right>Seq gaps</TH><TH>Last feed</TH></>} maxH="max-h-72">
              {rows.length === 0 && <tr><td colSpan={6} className="px-2.5 py-4 text-center text-muted-foreground">No rows match.</td></tr>}
              {rows.slice(0, 200).map((r: any, i: number) => (
                <tr key={`${r.instrument_key}|${i}`} className="border-t border-border/40 transition-colors hover:bg-black/[0.02]">
                  <td className="px-2.5 py-1.5 font-mono">{r.instrument_key}</td>
                  <td className="px-2.5 py-1.5"><Badge variant="outline" className={r.status === 'LIVE' ? 'border-emerald-500/40 text-emerald-700' : r.status === 'STALE' ? 'border-amber-500/40 text-amber-700' : r.status === 'NO_FEED' ? 'border-rose-500/40 text-rose-700' : ''}>{r.status}</Badge></td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.message_count)}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.duplicate_count)}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.sequence_gaps)}</td>
                  <td className="px-2.5 py-1.5 font-mono tabular-nums text-muted-foreground">{r.seconds_since_last_feed != null ? `${r.seconds_since_last_feed}s` : '—'}</td>
                </tr>
              ))}
            </TableShell>
            <p className="text-[11px] text-muted-foreground">showing {Math.min(200, rows.length)} of {rows.length} · thresholds degraded {overall.thresholds?.degraded_sec ?? '—'}s / stale {overall.thresholds?.stale_sec ?? '—'}s</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* SUBSCRIPTIONS + PINS                                                */
/* ------------------------------------------------------------------ */
function SubscriptionsPanel({ subs, loading, onSubscribe, onUnsubscribe }: any) {
  const [seg, setSeg] = useState('');
  const [tok, setTok] = useState('');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const all = (subs ?? []) as any[];
    const qq = q.trim().toLowerCase();
    if (!qq) return all;
    return all.filter((s: any) => String(s.instrument_token ?? '').includes(qq) || String(s.symbol ?? '').toLowerCase().includes(qq));
  }, [subs, q]);

  const exportCsv = () => {
    if (!rows.length) return;
    const url = URL.createObjectURL(new Blob([`segment,token,symbol,state\n${rows.map((s: any) => `${s.exchange_segment},${s.instrument_token},"${s.symbol ?? ''}",${s.state ?? ''}`).join('\n')}`], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ws-subscriptions.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Rss className="h-3.5 w-3.5" /></span>
          Wanted subscriptions · real registry
          <Badge variant="outline" className="tabular-nums">{fmtNum(rows.length)}</Badge>
          <span className="ml-auto flex items-center gap-1.5">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 w-32 pl-7 text-[11px]" />
            </div>
            <Button size="sm" variant="outline" className="h-7" onClick={exportCsv} disabled={!rows.length}>CSV</Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/[0.04] p-2.5">
          <Input className="h-8 w-24 font-mono text-xs" value={seg} onChange={(e) => setSeg(e.target.value)} placeholder="nse_cm" />
          <Input className="h-8 min-w-[140px] flex-1 font-mono text-xs" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="instrument token…" onKeyDown={(e) => { if (e.key === 'Enter' && seg.trim() && tok.trim()) { onSubscribe(seg.trim(), tok.trim()); setTok(''); } }} />
          <Button size="sm" onClick={() => { if (seg.trim() && tok.trim()) { onSubscribe(seg.trim(), tok.trim()); setTok(''); } }} className="bg-gradient-to-r from-violet-500 to-purple-600"><Save className="mr-1 h-3 w-3" /> Subscribe</Button>
        </div>
        {loading ? <Skeleton rows={4} /> : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{q ? `No match for "${q}".` : 'No desired subscriptions — add segment + token above.'}</p>
        ) : (
          <div className="max-h-96 space-y-1 overflow-auto">
            {rows.map((s: any, i: number) => (
              <div key={`${s.exchange_segment}|${s.instrument_token}|${i}`} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-black/[0.03] px-3 py-1.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-mono text-muted-foreground">{s.exchange_segment}</span>
                  <span className="shrink-0 font-mono font-bold">{s.instrument_token}</span>
                  {s.symbol && <span className="truncate text-muted-foreground">({s.symbol})</span>}
                  {s.state && <Badge variant="outline" className="shrink-0 text-[10px]">{s.state}</Badge>}
                </div>
                <Button size="sm" variant="ghost" aria-label="Unsubscribe" onClick={() => onUnsubscribe(s.exchange_segment, s.instrument_token)}><Trash2 className="h-3 w-3 text-rose-400" /></Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PinsPanel({ pins, loading, onAdd, onRemove }: any) {
  const [key, setKey] = useState('');
  const [sym, setSym] = useState('');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const all = (pins ?? []) as any[];
    const qq = q.trim().toLowerCase();
    if (!qq) return all;
    return all.filter((p: any) => String(p.instrument_key ?? '').toLowerCase().includes(qq) || String(p.symbol ?? '').toLowerCase().includes(qq));
  }, [pins, q]);

  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><PinIcon className="h-3.5 w-3.5" /></span>
          Pins · feed intent
          <Badge variant="outline" className="tabular-nums">{fmtNum(rows.length)}</Badge>
          <span className="relative ml-auto">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 w-32 pl-7 text-[11px]" />
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-2.5">
          <Input className="h-8 min-w-[140px] flex-1 font-mono text-xs" value={key} onChange={(e) => setKey(e.target.value)} placeholder="nse_cm|token" />
          <Input className="h-8 w-28 font-mono text-xs" value={sym} onChange={(e) => setSym(e.target.value)} placeholder="SYMBOL" />
          <Button size="sm" onClick={() => { if (key.includes('|')) { onAdd(key, sym); setKey(''); setSym(''); } }} className="bg-gradient-to-r from-amber-500 to-orange-600"><Save className="mr-1 h-3 w-3" /> Pin</Button>
        </div>
        {loading ? <Skeleton rows={4} /> : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">{q ? `No match for "${q}".` : 'No pins — add instrument key above.'}</p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-auto">
            {rows.map((p: any, i: number) => (
              <div key={`${p.instrument_key}|${i}`} className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-black/[0.03] px-3 py-1.5 text-xs">
                <div className="min-w-0">
                  <span className="font-mono font-bold">{p.instrument_key}</span>
                  <span className="ml-2 text-muted-foreground">{p.symbol || ''}</span>
                  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700">{p.source}</span>
                </div>
                <Button size="sm" variant="ghost" aria-label="Remove pin" onClick={() => onRemove(p.instrument_key)}><Trash2 className="h-3 w-3 text-rose-400" /></Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* CONSUMERS                                                           */
/* ------------------------------------------------------------------ */
function ConsumersPanel({ consumers, loading, onToggle }: any) {
  const [q, setQ] = useState('');
  const [onlyOff, setOnlyOff] = useState(false);
  const rows = useMemo(() => {
    const all = (consumers ?? []) as any[];
    const qq = q.trim().toLowerCase();
    return all.filter((c: any) => {
      if (onlyOff && c.enabled) return false;
      if (!qq) return true;
      return String(c.consumer_id ?? '').toLowerCase().includes(qq) || String(c.consumer_type ?? '').toLowerCase().includes(qq);
    });
  }, [consumers, q, onlyOff]);
  const offCount = (consumers ?? []).filter((c: any) => !c.enabled).length;

  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-sky-500/10 to-blue-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
          Consumers & routes
          <Badge variant="outline" className="tabular-nums">{fmtNum(rows.length)} shown</Badge>
          {offCount > 0 && <Badge variant="outline" className="border-amber-500/40 text-amber-700 tabular-nums">{offCount} off</Badge>}
          <span className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setOnlyOff((v) => !v)} className={cn('rounded-full border px-2.5 py-1 text-[11px] font-semibold', onlyOff ? 'border-amber-500/50 bg-amber-500/15 text-amber-800' : 'border-border text-muted-foreground')}>Disabled only</button>
            <span className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 w-36 pl-7 text-[11px]" />
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? <Skeleton rows={5} /> : rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No consumers match — routes appear when the engine registers them.</p>
        ) : (
          <TableShell head={<><TH>Consumer · route</TH><TH>Type</TH><TH>Profile</TH><TH>Priority</TH><TH right>Queue</TH><TH right>Delayed/Drop</TH><TH>On/Off</TH></>} maxH="max-h-[28rem]">
            {rows.map((c: any) => (
              <tr key={c.consumer_id} className="border-t border-border/40 transition-colors hover:bg-black/[0.02]">
                <td className="px-2.5 py-1.5 font-mono">{c.consumer_id} <span className="text-muted-foreground">{c.route_id}</span></td>
                <td className="px-2.5 py-1.5">{c.consumer_type}</td>
                <td className="px-2.5 py-1.5 font-mono">{c.profile_id}</td>
                <td className="px-2.5 py-1.5"><Badge variant="outline">{c.priority}</Badge></td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{c.queue_size}</td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{c.backpressure_deferred}/{c.backpressure_dropped}</td>
                <td className="px-2.5 py-1.5">
                  <Button size="sm" variant={c.enabled ? 'default' : 'outline'} className={cn('h-7', c.enabled && 'bg-gradient-to-r from-emerald-500 to-emerald-600')} onClick={() => onToggle(c, !c.enabled)}>
                    {c.enabled ? 'On' : 'Off'}
                  </Button>
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* FIELDS                                                              */
/* ------------------------------------------------------------------ */
function FieldVerificationPanel({ fv, loading, onRefresh }: any) {
  const [zoomField, setZoomField] = useState('ALL');
  const [fieldSearch, setFieldSearch] = useState('');
  const counts = useMemo(() => (fv ? countsByStatus(fv.status_counts) : []), [fv]);
  const fvRows = useMemo(() => (fv ? fieldRowsFiltered(fv.rows, zoomField, fieldSearch) : []), [fv, zoomField, fieldSearch]);
  const total = fv?.total ?? 0;
  const maxC = Math.max(1, ...counts.map((c) => c.count));

  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-teal-500/10 to-emerald-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 p-1.5 text-white shadow"><CheckCircle2 className="h-3.5 w-3.5" /></span>
          Field verification · {fmtNum(total)} fields
          <span className="ml-auto flex items-center gap-1.5">
            <span className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-7 w-48 pl-7 text-[11px]" placeholder="Search field / kotak attr…" value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} />
            </span>
            <button onClick={onRefresh} aria-label="Refresh fields" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {loading ? <Skeleton rows={4} /> : (
          <>
            <div className="space-y-1">
              {counts.map((c) => (
                <button key={c.status} onClick={() => setZoomField(zoomField === c.status ? 'ALL' : c.status)} className="flex w-full items-center gap-2 text-[11px]" title="Filter table">
                  <span className={cn('w-44 shrink-0 truncate text-left font-mono', zoomField === c.status && 'font-bold text-foreground')}>{statusShort(c.status)}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted/70">
                    <span className={cn('block h-full rounded-full', statusTone(c.status))} style={{ width: `${(c.count / maxC) * 100}%` }} />
                  </span>
                  <span className="w-14 shrink-0 text-right font-mono tabular-nums">{fmtNum(c.count)}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{zoomField === 'ALL' ? 'Showing all statuses' : `Filtering: ${statusShort(zoomField)}`} · first {fvRows.length} rows</p>
            <TableShell head={<><TH>#</TH><TH>Schema field</TH><TH>Status</TH><TH>Kotak attr</TH><TH>Feed level</TH><TH>D/D</TH></>}>
              {fvRows.length === 0 && <tr><td colSpan={6} className="px-2.5 py-4 text-center text-muted-foreground">No fields match.</td></tr>}
              {fvRows.slice(0, 120).map((r) => (
                <tr key={r.num} className="border-t border-border/40 transition-colors hover:bg-black/[0.02]">
                  <td className="px-2.5 py-1.5 font-mono tabular-nums">{r.num}</td>
                  <td className="px-2.5 py-1.5 font-medium">{r.field}</td>
                  <td className="px-2.5 py-1.5"><Badge className={statusTone(r.status)}>{statusShort(r.status)}</Badge></td>
                  <td className="px-2.5 py-1.5 font-mono">{r.kotak_attr || '—'}</td>
                  <td className="px-2.5 py-1.5 font-mono">{r.feed_level || '—'}</td>
                  <td className="px-2.5 py-1.5 font-mono">{r.direct_derived || '—'}</td>
                </tr>
              ))}
            </TableShell>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* RAW STREAM                                                          */
/* ------------------------------------------------------------------ */
function RawStreamPanel({ rawData, rawTok, setRawTok, loading, onRefresh }: any) {
  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-slate-500/10 to-zinc-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-slate-500 to-zinc-600 p-1.5 text-white shadow"><ScrollText className="h-3.5 w-3.5" /></span>
          Raw stream · canonical, immutable
          <span className="ml-auto flex items-center gap-2">
            <Input className="h-7 w-44 font-mono text-[11px]" value={rawTok} onChange={(e) => setRawTok(e.target.value)} placeholder="nse_cm|token" onKeyDown={(e) => { if (e.key === 'Enter') onRefresh(); }} />
            <Button size="sm" variant="outline" className="h-7" onClick={onRefresh}><RefreshCw className="mr-1 h-3 w-3" /> Load</Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? <Skeleton rows={4} /> : (rawData ?? []).length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No ticks for this token yet — instrument must be subscribed and feed active.</p>
        ) : (
          <TableShell head={<><TH>Symbol</TH><TH>Feed</TH><TH right>LTP</TH><TH right>Vol</TH><TH right>Buy/Sell</TH><TH>Received</TH><TH>Raw ref</TH></>} maxH="max-h-96">
            {(rawData ?? []).map((r: any, i: number) => (
              <tr key={i} className="border-t border-border/40 transition-colors hover:bg-black/[0.02]">
                <td className="px-2.5 py-1.5 font-medium">{r.trading_symbol ?? `${r.exchange_segment}|${r.instrument_token}`}</td>
                <td className="px-2.5 py-1.5 font-mono">{r.feed_type}{r.feed_level != null ? ` L${r.feed_level}` : ''}</td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.fields?.ltp ?? '—'}</td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.fields?.volume)}</td>
                <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.fields?.buy?.length ?? 0}/{r.fields?.sell?.length ?? 0}</td>
                <td className="px-2.5 py-1.5"><AgeTicker ts={r.received_at} /></td>
                <td className="max-w-[140px] truncate px-2.5 py-1.5 font-mono text-muted-foreground" title={r.raw_reference}>{r.raw_reference}</td>
              </tr>
            ))}
          </TableShell>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* RESOURCES                                                           */
/* ------------------------------------------------------------------ */
function ResourcesPanel({ resources, loading, onRefresh }: any) {
  const ramPct = resources?.ram_percent;
  const severity = resources?.severity ?? 'UNKNOWN';
  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-orange-500/10 to-amber-500/5 pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 p-1.5 text-white shadow"><Cpu className="h-3.5 w-3.5" /></span>
          Degradation policy · real thresholds
          <Badge className={cn('ml-auto', severityTone(severity))}>{severity}</Badge>
          <button onClick={onRefresh} aria-label="Refresh resources" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {loading ? <Skeleton rows={4} /> : (
          <>
            <div>
              <div className="mb-1 flex justify-between text-[11px]"><span className="text-muted-foreground">RAM now</span><span className="font-mono font-bold tabular-nums">{ramPct != null ? `${Number(ramPct).toFixed(1)}%` : '—'}</span></div>
              <div className="h-2.5 overflow-hidden rounded-full bg-muted/70">
                <div className={cn('h-full rounded-full transition-all', (ramPct ?? 0) >= (resources?.thresholds?.critical_pct ?? 95) ? 'bg-gradient-to-r from-rose-500 to-rose-400' : (ramPct ?? 0) >= (resources?.thresholds?.warning_pct ?? 70) ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-emerald-500 to-emerald-400')} style={{ width: `${Math.min(100, Number(ramPct ?? 0))}%` }} />
              </div>
              <div className="mt-1 flex gap-3 text-[11px] text-muted-foreground">
                <span>warn <span className="font-mono">{resources?.thresholds?.warning_pct ?? '—'}%</span></span>
                <span>high <span className="font-mono">{resources?.thresholds?.high_pct ?? '—'}%</span></span>
                <span>critical <span className="font-mono">{resources?.thresholds?.critical_pct ?? '—'}%</span></span>
                <span className="ml-auto">cpu <span className="font-mono">{resources?.cpu_percent != null ? `${Number(resources.cpu_percent).toFixed(1)}%` : '—'}</span></span>
              </div>
            </div>
            {(resources?.actions?.actions ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {resources.actions.actions.map((a: any, i: number) => (
                  <Badge key={i} variant={a.action === 'STOP' ? 'destructive' : 'outline'}>{a.service} → {a.action}</Badge>
                ))}
              </div>
            )}
            <TableShell head={<><TH>Priority</TH><TH>Service</TH><TH>Action</TH><TH right>RAM threshold</TH><TH>Enabled</TH></>}>
              {(resources?.policy ?? []).length === 0 && <tr><td colSpan={5} className="px-2.5 py-3 text-center text-muted-foreground">No policy configured.</td></tr>}
              {(resources?.policy ?? []).map((p: any, i: number) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="px-2.5 py-1.5 font-mono">P{p.priority}</td>
                  <td className="px-2.5 py-1.5 font-medium">{p.service}</td>
                  <td className="px-2.5 py-1.5"><Badge variant={p.action === 'STOP' ? 'destructive' : 'outline'}>{p.action}</Badge></td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{p.ram_threshold}%</td>
                  <td className="px-2.5 py-1.5">{p.enabled ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </TableShell>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* HISTORY + CONFIG                                                    */
/* ------------------------------------------------------------------ */
function HistoryPanel({ history, events, loading, onRefreshHistory, onRefreshEvents }: any) {
  const records = history?.records ?? [];
  const [q, setQ] = useState('');
  const evFiltered = useMemo(() => {
    const eventRows = events?.events ?? [];
    const qq = q.trim().toLowerCase();
    if (!qq) return eventRows;
    return eventRows.filter((r: any) => String(r.event_type ?? '').toLowerCase().includes(qq) || String(r.message ?? '').toLowerCase().includes(qq));
  }, [events, q]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-slate-500/10 to-zinc-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-slate-500 to-zinc-600 p-1.5 text-white shadow"><ScrollText className="h-3.5 w-3.5" /></span>
            Connection history · persisted
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(records.length)}</Badge>
            <button onClick={onRefreshHistory} aria-label="Refresh history" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {loading ? <Skeleton rows={4} /> : (history?.note || records.length === 0) ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{history?.note ?? 'No connection records persisted yet.'}</p>
          ) : (
            <TableShell head={<><TH>Connected</TH><TH>Status</TH><TH right>Duration</TH><TH right>Msgs</TH><TH right>Ticks</TH><TH right>Err</TH></>} maxH="max-h-72">
              {records.map((r: any, i: number) => (
                <tr key={i} className="border-t border-border/40">
                  <td className="px-2.5 py-1.5"><AgeTicker ts={r.connected_at} /></td>
                  <td className="px-2.5 py-1.5"><Badge variant={r.status === 'open' ? 'default' : 'outline'}>{r.status ?? '—'}</Badge></td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{r.duration_sec != null ? `${Math.round(r.duration_sec)}s` : '—'}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.messages_received)}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.ticks_received)}</td>
                  <td className="px-2.5 py-1.5 text-right font-mono tabular-nums">{fmtNum(r.error_count)}</td>
                </tr>
              ))}
            </TableShell>
          )}
          {records[0]?.reason && <p className="pt-2 text-[11px] text-muted-foreground">latest reason: <span className="font-mono text-foreground">{records[0].reason}</span></p>}
        </CardContent>
      </Card>

      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-rose-500/10 to-amber-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-rose-500 to-amber-600 p-1.5 text-white shadow"><AlertTriangle className="h-3.5 w-3.5" /></span>
            Events · persisted ledger
            <Badge variant="outline" className="tabular-nums">{fmtNum(evFiltered.length)}</Badge>
            <span className="relative ml-auto">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 w-32 pl-7 text-[11px]" />
            </span>
            <button onClick={onRefreshEvents} aria-label="Refresh events" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {loading ? <Skeleton rows={4} /> : (events?.note || (events?.events ?? []).length === 0) ? (
            <p className="py-6 text-center text-xs text-muted-foreground">{events?.note ?? 'No events persisted yet.'}</p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-auto">
              {evFiltered.slice(0, 150).map((r: any, i: number) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-border/40 bg-black/[0.03] px-2 py-1.5 text-[11px]">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', r.severity === 'error' ? 'bg-rose-400' : r.severity === 'warn' ? 'bg-amber-400' : 'bg-sky-400')} />
                  <span className="shrink-0 font-mono font-semibold">{r.event_type}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={r.message}>{r.message}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTime(r.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ConfigPanel({ config, loading, onRefresh }: any) {
  const rc = config?.reconnect ?? {};
  return (
    <Card className="overflow-hidden shadow-soft">
      <CardHeader className="bg-gradient-to-r from-teal-500/10 to-emerald-500/5 pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <span className="rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 p-1.5 text-white shadow"><Settings2 className="h-3.5 w-3.5" /></span>
          Configuration · WS-owned, read-only
          <button onClick={onRefresh} aria-label="Refresh config" className="ml-auto text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-3">
        {loading ? <Skeleton rows={4} /> : (
          <>
            <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
              {([['Schema version', config?.schema_version], ['SDK version', config?.sdk_version], ['Auto reconnect', rc.ws_auto_reconnect == null ? null : String(rc.ws_auto_reconnect)], ['Backoff', rc.ws_backoff == null ? null : String(rc.ws_backoff)], ['Reconnect delay ms', rc.ws_reconnect_delay_ms], ['Max reconnect attempts', rc.ws_max_reconnect_attempts]] as const).map(([l, v]) => (
                <p key={l} className="flex justify-between gap-2 rounded-lg border-b border-border/40 px-2 py-1.5"><span className="text-muted-foreground">{l}</span><span className="truncate font-mono" title={String(v ?? '—')}>{v == null ? '—' : String(v)}</span></p>
              ))}
            </div>
            {config?.feed_levels && (
              <div>
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Subscribed feed levels · real</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(config.feed_levels).filter(([, v]) => Number(v) > 0).map(([k, v]) => (
                    <Badge key={k} variant="outline" className="tabular-nums">{k} · {String(v)}</Badge>
                  ))}
                </div>
              </div>
            )}
            {config?.quality_thresholds && (
              <p className="flex flex-wrap gap-x-6 text-xs text-muted-foreground">Quality thresholds
                <span>Degraded <span className="font-mono text-foreground">{config.quality_thresholds.degraded_sec ?? '—'}s</span></span>
                <span>Stale <span className="font-mono text-foreground">{config.quality_thresholds.stale_sec ?? '—'}s</span></span>
              </p>
            )}
            {config?.resource_thresholds && (
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(config.resource_thresholds).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="font-mono tabular-nums">{k}={String(v)}</Badge>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* REAL-TIME FLOW — pipeline canvas (input → core → output)             */
/* ------------------------------------------------------------------ */
function NodeDot({ online, label }: { online: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold tabular-nums',
      online ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/50 bg-rose-500/10 text-rose-700')}>
      <span className={cn('h-1.5 w-1.5 rounded-full', online ? 'animate-pulse bg-emerald-500' : 'bg-rose-500')} />
      {label}
    </span>
  );
}

/** Vertical animated connector — streams only while data actually flows. */
function VPipe({ active, label, color }: { active: boolean; label?: string; color: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-0.5">
      <span
        className={cn('ws-pipe h-7 w-2.5 rounded-sm', active ? 'is-flowing' : 'is-idle')}
        style={{ '--flow-color': color } as CSSProperties}
      />
      {active && <span className={cn('ws-packet-drop h-1.5 w-1.5 rounded-full')} style={{ background: color }} />}
      {label && <span className="font-mono text-[9px] text-muted-foreground" title={label}>{label}</span>}
    </div>
  );
}

/* Tiny radix-free sparkline built from REAL sampled tick rates. */
function TpsSpark({ samples }: { samples: number[] }) {
  if (samples.length < 2) return null;
  const w = 96; const h = 22;
  const max = Math.max(1, ...samples);
  const pts = samples.map((v, i) => `${(i / (samples.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polyline points={pts} fill="none" stroke="url(#tpsGrad)" strokeWidth="2" strokeLinecap="round" />
      <defs><linearGradient id="tpsGrad" x1="0" x2="1"><stop offset="0%" stopColor="#8b5cf6" /><stop offset="100%" stopColor="#06b6d4" /></linearGradient></defs>
    </svg>
  );
}

function FlowPanel({ flow, flowError, loading, samples, onRefresh }: any) {
  const inp = flow?.input ?? {};
  const core = flow?.core ?? {};
  const out = flow?.output ?? {};
  const rates = inp.rates ?? {};
  const mps = Number(rates.messages_per_second ?? 0);
  const tpsFlow = Number(rates.ticks_per_second ?? 0);
  const flowing = mps > 0 || tpsFlow > 0;
  const levels = core.feed_levels ?? {};
  const qCounts = core.quality_counts ?? {};
  const lat = core.latency ?? {};
  const consumers = (out.consumers ?? []) as any[];
  const stages = core.pipeline_stages ?? {};
  const stageEntries = Object.entries(stages) as Array<[string, any]>;
  const life = inp.lifecycle ?? 'UNKNOWN';
  const online = inp.state === 'CONNECTED' && inp.internet_ok !== false;
  const tpsAvg5 = Number(rates.ticks_5s_average ?? 0);
  const mpsAvg5 = Number(rates.messages_5s_average ?? 0);

  return (
    <div className="space-y-4">
      {/* STATUS BAR */}
      <Card className="relative overflow-hidden border shadow-soft">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-cyan-500 to-emerald-500" />
        <CardContent className="flex flex-wrap items-center gap-2.5 p-3.5">
          <NodeDot online={online} label={online ? 'WS#1 ONLINE — feed channel open' : 'WS#1 OFFLINE — no upstream data'} />
          <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 font-mono tabular-nums text-violet-700">msgs {mps.toFixed(1)}/s · 5s avg {mpsAvg5.toFixed(1)}</Badge>
          <Badge variant="outline" className="border-cyan-500/40 bg-cyan-500/10 font-mono tabular-nums text-cyan-700">ticks {tpsFlow.toFixed(1)}/s · 5s avg {tpsAvg5.toFixed(1)}</Badge>
          <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 font-mono tabular-nums text-sky-700">60s msgs {fmtNum(rates.messages_60s_average)}</Badge>
          <span className="ml-auto flex items-center gap-2" title="tick/s sampled on every refresh (real values)">
            <TpsSpark samples={samples} />
            <button onClick={onRefresh} aria-label="Refresh flow" className="text-muted-foreground hover:text-foreground"><RefreshCw className="h-3.5 w-3.5" /></button>
          </span>
          {!loading && flowError && <span className="w-full text-xs text-rose-700">Flow unavailable: {flowError}</span>}
        </CardContent>
      </Card>

      {/* STAGE 1 — INPUT */}
      <Card className={cn('overflow-hidden border shadow-soft', online ? 'border-emerald-500/30' : 'border-rose-500/30')}>
        <CardHeader className={cn('border-b pb-2', online ? 'border-emerald-500/20 bg-emerald-500/[0.06]' : 'border-rose-500/20 bg-rose-500/[0.05]')}>
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn('rounded-lg p-1.5', online ? 'bg-emerald-500/10 text-emerald-700' : 'bg-rose-500/10 text-rose-700')}>
              <Wifi className="h-3.5 w-3.5" />
            </span>
            INPUT · broker upstream
            <NodeDot online={online} label={String(inp.state ?? '—')} />
            {!loading && flowError && <Badge variant="outline" className="ml-auto border-rose-500/40 text-rose-700">engine unavailable</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-6 gap-y-1 pt-3 text-xs sm:grid-cols-2">
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">upstream owner</span><span className="font-mono font-semibold">{inp.owner ?? '—'}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">supervisor</span><span className="truncate font-mono">{inp.supervisor ?? '—'}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">lifecycle</span><span className="font-mono">{life}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">feed state</span><span className="font-mono font-semibold">{inp.feed_state ?? '—'}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">internet</span><NodeDot online={inp.internet_ok === true} label={inp.internet_ok == null ? '—' : inp.internet_ok ? 'OK' : 'DOWN'} /></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">session auth</span><span className="truncate font-mono">{[inp.session_broker, inp.session_state].filter(Boolean).join(' · ') || '—'}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">ws id</span><span className="max-w-[140px] truncate font-mono" title={inp.websocket_id ?? ''}>{inp.websocket_id ?? '—'}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">upstream subscribed</span><span className="font-mono tabular-nums">{fmtNum(inp.subscriptions_upstream)}</span></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">last broker message</span><AgeTicker ts={inp.last_message_at} /></p>
          <p className="flex justify-between gap-2"><span className="text-muted-foreground">last tick</span><AgeTicker ts={inp.last_tick_at} /></p>
          {inp.disconnect_reason && <p className="sm:col-span-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px]">last disconnect: <span className="font-mono">{inp.disconnect_reason}{inp.disconnect_reason_code ? ` (${inp.disconnect_reason_code})` : ''}</span> · reconnects <span className="font-mono font-bold">{fmtNum(inp.reconnect_count)}</span></p>}
        </CardContent>
      </Card>

      <VPipe active={flowing} color="#06b6d4" label={flowing ? `${mps.toFixed(1)} msgs/s in` : 'idle — no inbound frames'} />

      {/* STAGE 2 — CORE */}
      <Card className="overflow-hidden border-violet-500/30 shadow-soft">
        <CardHeader className="border-b border-violet-500/20 bg-violet-500/[0.06] pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-violet-500/10 p-1.5 text-violet-700"><ShieldCheck className="h-3.5 w-3.5" /></span>
            CORE · registry, validation & quality
            <Badge variant="outline" className="ml-auto tabular-nums text-violet-700">subs {fmtNum(core.subscriptions)} / desired {fmtNum(core.desired)}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 pt-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([['Subscriptions', core.subscriptions, 'text-violet-700'], ['Desired', core.desired, ''], ['Pins', core.pins, 'text-amber-700'], ['Raw tokens', core.raw_tokens, 'text-slate-700']] as const).map(([l, v, tone]) => (
              <div key={l} className="rounded-xl border border-border/60 bg-black/[0.02] px-2.5 py-2">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{l}</p>
                <p className={cn('font-mono text-lg font-extrabold tabular-nums', tone)}>{fmtNum(v as number)}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {(['L4', 'L8', 'L16', 'INDEX'] as const).map((k) => (
              <div key={k} className="flex items-center justify-between rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-1.5 text-[11px]">
                <span className={cn('rounded px-1.5 font-mono font-bold', k === 'L8' ? 'bg-fuchsia-500/15 text-fuchsia-700' : k === 'L16' ? 'bg-purple-500/15 text-purple-700' : k === 'L4' ? 'bg-slate-500/15 text-slate-700' : 'bg-sky-500/15 text-sky-700')}>{k}</span>
                <span className="font-mono tabular-nums">{fmtNum(Number(levels[k] ?? 0))}</span>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-1.5 text-[11px]" title="quality snapshot rate">
              <span className="font-mono font-bold text-cyan-700">q-rate</span>
              <span className="font-mono tabular-nums">{fmtNum(core.quality_msg_rate)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(['LIVE', 'DEGRADED', 'STALE', 'NO_FEED'] as const).map((k) => {
              const c = Number(qCounts[k] ?? 0);
              return (
                <Badge key={k} variant="outline" className={cn('gap-1 tabular-nums font-bold',
                  k === 'LIVE' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
                  : k === 'STALE' ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                  : k === 'DEGRADED' ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700'
                  : 'border-slate-500/40 bg-slate-500/10 text-slate-700')}>
                  {k} {fmtNum(c)}
                </Badge>
              );
            })}
            <Badge variant="outline" className="tabular-nums text-muted-foreground">p50 {lat.p50_ms != null ? `${Number(lat.p50_ms).toFixed(1)}ms` : '—'}</Badge>
            <Badge variant="outline" className="tabular-nums text-muted-foreground">p95 {lat.p95_ms != null ? `${Number(lat.p95_ms).toFixed(1)}ms` : '—'}</Badge>
            <Badge variant="outline" className="tabular-nums text-muted-foreground">dupes {fmtNum(core.duplicate_total)} · invalid {fmtNum(core.invalid_total)}</Badge>
          </div>
          {stageEntries.length === 0 && (
            <p className="rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-1.5 text-[11px] text-muted-foreground">
              pipeline hop-latency: <span className="font-mono">awaiting feed samples</span> — stages record real A→G hop measurements only while ticks flow (pipelineLatency semantics, backend-measured).
            </p>
          )}
          {stageEntries.length > 0 && (
            <div className="space-y-1">
              {stageEntries.map(([k, v]) => {
                const pct = Math.max(0, Math.min(100, Number(v?.avg_ms ?? v?.p50_ms ?? v ?? 0)));
                return (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    <span className="w-40 shrink-0 truncate font-mono font-semibold">{k}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/70">
                      <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right font-mono tabular-nums">{typeof v === 'number' ? `${v.toFixed(1)}ms` : Number(v?.avg_ms ?? 0).toFixed(1)}ms</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <VPipe active={flowing} color="#8b5cf6" label={flowing ? 'validated tick documents out' : 'idle — nothing to route'} />

      {/* STAGE 3 — OUTPUT */}
      <Card className="overflow-hidden border shadow-soft">
        <CardHeader className="border-b bg-gradient-to-r from-cyan-500/[0.07] to-emerald-500/[0.05] pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-cyan-500/10 p-1.5 text-cyan-700"><Database className="h-3.5 w-3.5" /></span>
            OUTPUT · where ticks are served
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(out.active_routes)} routes · {fmtNum(out.active_consumers)} online consumers</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {loading || consumers.length === 0 ? (
            loading ? <Skeleton rows={2} /> : <p className="py-4 text-center text-xs text-muted-foreground">No consumers registered — engine abhi kisi ko serve nahi kar raha.</p>
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {consumers.map((c: any) => {
                const cOnline = !!c.online && !!c.enabled;
                return (
                  <div key={c.consumer_id} className={cn('rounded-xl border bg-gradient-to-br from-card via-card p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-soft', cOnline ? 'border-emerald-500/30' : 'border-slate-500/30')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-lg bg-cyan-500/10 p-1.5"><Database className={cn('h-3.5 w-3.5', cOnline ? 'text-cyan-700' : 'text-slate-500')} /></span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold" title={c.consumer_id}>{c.consumer_id}</span>
                      <NodeDot online={cOnline} label={cOnline ? 'SERVING' : c.enabled ? 'OFFLINE' : 'DISABLED'} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
                      <div className="rounded-lg border border-border/60 bg-black/[0.02] px-2 py-1"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">type · route</p><p className="truncate font-mono">{c.consumer_type} · {c.route_id ?? '—'}</p></div>
                      <div className="rounded-lg border border-border/60 bg-black/[0.02] px-2 py-1"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">profile · priority</p><p className="font-mono">{c.profile_id ?? '—'} · {c.priority ?? '—'}</p></div>
                      <div className="rounded-lg border border-border/60 bg-black/[0.02] px-2 py-1" title="queue depth right now"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">queue</p><p className="font-mono tabular-nums">{fmtNum(c.queue_size)}</p></div>
                      <div className="rounded-lg border border-border/60 bg-black/[0.02] px-2 py-1" title="backpressure counters"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">deferred / dropped</p><p className="font-mono tabular-nums">{fmtNum(c.backpressure_deferred)} / {fmtNum(c.backpressure_dropped)}</p></div>
                    </div>
                    {cOnline && flowing && <p className="mt-1.5 text-[10px] text-emerald-700"><span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 align-middle" />live — documents routing right now</p>}
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Ye dashboard khud REST/polling se consume karta hai (WS#2 frames se status hota hai) — socket par koi second connection nahi kholti. Consumers registry se hi pata chalta hai backend kisko serve kar raha hai.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TABS + PAGE                                                         */
/* ------------------------------------------------------------------ */
const TABS = [
  { id: 'overview', label: 'Overview', icon: Zap, accent: 'cyan' },
  { id: 'flow', label: 'Flow', icon: Workflow, accent: 'fuchsia' },
  { id: 'connection', label: 'Connection', icon: RotateCw, accent: 'emerald' },
  { id: 'feed', label: 'Live Feed', icon: Activity, accent: 'emerald' },
  { id: 'quality', label: 'Quality', icon: Gauge, accent: 'amber' },
  { id: 'subscriptions', label: 'Subscriptions', icon: Rss, accent: 'violet' },
  { id: 'pins', label: 'Pins', icon: PinIcon, accent: 'amber' },
  { id: 'consumers', label: 'Consumers', icon: Layers, accent: 'sky' },
  { id: 'fields', label: 'Fields', icon: CheckCircle2, accent: 'fuchsia' },
  { id: 'raw', label: 'Raw Stream', icon: ScrollText, accent: 'slate' },
  { id: 'resources', label: 'Resources', icon: Cpu, accent: 'rose' },
  { id: 'history', label: 'History', icon: ScrollText, accent: 'slate' },
  { id: 'config', label: 'Config', icon: Settings2, accent: 'emerald' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function WebSocketEnginePage() {
  const [tab, setTab] = useState<TabId>('overview');
  const { data: statusData, error: statusError, refresh: refreshStatus } = useEngineStatus<any>('websocket_engine', `${WE}/status`);

  const status = statusData?.engineStatus ?? statusData ?? null;
  const owner = statusData?.ownerStatus ?? statusData?.engineStatus?.owner_status ?? status?.owner_status ?? {};
  const connected = (status?.connection_connected ?? owner.connected) === true;
  const statusLoading = !status && !statusError;

  // LAZY: only the open tab fetches (mount + tab switch), never all 12 at once
  const metrics = useOneShot<any>(`${WE}/metrics`, tab === 'overview');
  const resources = useOneShot<any>(`${WE}/resources`, tab === 'overview' || tab === 'resources');
  const subs = useOneShot<any[]>(`${WE}/subscriptions`, tab === 'subscriptions');
  const pins = useOneShot<any[]>(`${WE}/pins`, tab === 'pins');
  const consumers = useOneShot<any[]>(`${WE}/consumers`, tab === 'consumers');
  const fv = useOneShot<any>(`${WE}/field-verification`, tab === 'fields');
  const quality = useOneShot<any>(`${WE}/quality`, tab === 'quality');
  const history = useOneShot<any>(`${WE}/history?limit=50`, tab === 'history');
  const events = useOneShot<any>(`${WE}/events?limit=100`, tab === 'history');
  const config = useOneShot<any>(`${WE}/config`, tab === 'config');
  const live = useOneShot<any>(`${WE}/live-feed?window_sec=10`, tab === 'feed');
  // Flow canvas: ONE aggregated call (input/core/output) from the live engine.
  const flow = useOneShot<any>(`${WE}/flow`, tab === 'flow');

  // Real sampled tick/s history for the flow sparkline — only while Flow tab is
  // open; every refresh appends one REAL value (capped at 40 samples).
  const [tpsSamples, setTpsSamples] = useState<number[]>([]);
  useEffect(() => {
    if (tab !== 'flow' || !flow.data) return;
    const tps = Number(flow.data?.input?.rates?.ticks_per_second ?? 0);
    setTpsSamples((prev) => {
      const next = [...prev, tps];
      return next.length > 40 ? next.slice(next.length - 40) : next;
    });
  }, [tab, flow.data]);

  // throttled cadence: ONLY the open tab, max 1/15s (feed 10s), hidden paused
  useTabCadence(metrics.refresh, tab === 'overview', 15000);
  useTabCadence(resources.refresh, tab === 'overview' || tab === 'resources', 15000);
  useTabCadence(live.refresh, tab === 'feed', 10000);
  useTabCadence(flow.refresh, tab === 'flow', 6000);
  useTabCadence(quality.refresh, tab === 'quality', 15000);
  useTabCadence(subs.refresh, tab === 'subscriptions', 20000);
  useTabCadence(pins.refresh, tab === 'pins', 20000);
  useTabCadence(consumers.refresh, tab === 'consumers', 20000);
  useTabCadence(history.refresh, tab === 'history', 30000);
  useTabCadence(events.refresh, tab === 'history', 30000);

  const [rawTok, setRawTok] = useState('nse_cm|');
  const [rawData, setRawData] = useState<any[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connResult, setConnResult] = useState<{ action: string; ok: boolean; error?: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((err?: string, okText = 'Done') => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ kind: err ? 'err' : 'ok', text: err ? err : okText });
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const loadRaw = useCallback(async () => {
    if (!rawTok.includes('|')) return;
    setRawLoading(true);
    try {
      const res = await fetch(`${WE}/raw-stream?token=${encodeURIComponent(rawTok)}&limit=20`);
      const body = await res.json().catch(() => null);
      if (body?.ok) setRawData(body.data ?? []);
    } catch {
      /* keep last frame */
    } finally {
      setRawLoading(false);
    }
  }, [rawTok]);

  const postAction = useCallback(async (path: string, body?: unknown): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body == null ? '{}' : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: !!data.ok && res.ok, error: data.error };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : 'request failed' };
    }
  }, []);

  const connAction = useCallback(async (action: string) => {
    setBusy(action);
    setConnResult(null);
    const r = await postAction(`${WE}/${action}`);
    setConnResult({ action, ok: r.ok, error: r.error });
    setBusy(null);
    refreshStatus();
  }, [postAction, refreshStatus]);

  const subscribeToken = useCallback(async (seg: string, tokNum: string) => {
    const r = await postAction(`${WE}/subscribe`, { tokens: [{ exchange_segment: seg, instrument_token: tokNum }] });
    flash(r.ok ? '' : r.error, `Subscribed ${tokNum}`);
    subs.refresh();
    refreshStatus();
  }, [postAction, flash, subs, refreshStatus]);

  const unsubscribeToken = useCallback(async (seg: string, tokNum: string) => {
    const r = await postAction(`${WE}/unsubscribe`, { tokens: [{ exchange_segment: seg, instrument_token: tokNum }] });
    flash(r.ok ? '' : r.error, `Unsubscribed ${tokNum}`);
    subs.refresh();
    refreshStatus();
  }, [postAction, flash, subs, refreshStatus]);

  const addPin = useCallback(async (key: string, sym: string) => {
    const r = await postAction(`${WE}/pins`, { instrument_key: key, symbol: sym || key.split('|')[1], source: 'manual', priority: 1 });
    flash(r.ok ? '' : r.error, 'Pin set');
    pins.refresh();
    refreshStatus();
  }, [postAction, flash, pins, refreshStatus]);

  const removePin = useCallback(async (key: string) => {
    try {
      const res = await fetch(`${WE}/pins/${encodeURIComponent(key)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      flash(data.ok && res.ok ? '' : data.error, 'Pin removed');
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'request failed', '');
    }
    pins.refresh();
    refreshStatus();
  }, [flash, pins, refreshStatus]);

  const toggleConsumer = useCallback(async (row: any, enabled: boolean) => {
    try {
      const res = await fetch(`${WE}/consumers/${encodeURIComponent(row.consumer_id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      const data = await res.json().catch(() => ({}));
      flash(data.ok && res.ok ? '' : data.error, `${row.consumer_id} → ${enabled ? 'On' : 'Off'}`);
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : 'request failed', '');
    }
    consumers.refresh();
  }, [flash, consumers]);

  const refreshAll = useCallback(() => {
    refreshStatus();
    if (tab === 'overview') { metrics.refresh(); resources.refresh(); }
    if (tab === 'flow') flow.refresh();
    if (tab === 'feed') live.refresh();
    if (tab === 'quality') quality.refresh();
    if (tab === 'subscriptions') subs.refresh();
    if (tab === 'pins') pins.refresh();
    if (tab === 'consumers') consumers.refresh();
    if (tab === 'fields') fv.refresh();
    if (tab === 'raw') void loadRaw();
    if (tab === 'resources') resources.refresh();
    if (tab === 'history') { history.refresh(); events.refresh(); }
    if (tab === 'config') config.refresh();
  }, [refreshStatus, tab, metrics, resources, flow, live, quality, subs, pins, consumers, fv, loadRaw, history, events, config]);

  const tabCount = (id: TabId): string | null => {
    if (id === 'subscriptions' && Array.isArray(subs.data)) return fmtNum(subs.data.length);
    if (id === 'pins' && Array.isArray(pins.data)) return fmtNum(pins.data.length);
    if (id === 'consumers' && Array.isArray(consumers.data)) return fmtNum(consumers.data.length);
    return null;
  };

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-cyan-500/[0.12] via-primary/[0.06] to-violet-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 via-primary to-violet-500 text-white shadow-xl">
            <Rss className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">WebSocket Engine</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Central Kotak SFeed owner · WS#1 single socket · real ticks only · {fmtNum(status?.subscription_count)} subscriptions
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={connected ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-800' : 'border border-rose-500/40 bg-gradient-to-r from-rose-500/25 to-rose-500/10 text-rose-800'}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-emerald-400' : 'bg-rose-400')} />
              {connected ? 'WS#1 CONNECTED' : 'WS#1 OFFLINE'}
            </Badge>
            <Badge variant="outline" className="hidden font-mono text-[10px] sm:inline-flex">schema v{status?.schema_version ?? '—'} · SDK {status?.sdk_version ?? '—'}</Badge>
            <Badge variant="outline" className="tabular-nums">{owner?.feed_state ?? '—'}</Badge>
            {notice && <Badge variant="outline" className={notice.kind === 'ok' ? 'border-emerald-500/40 text-emerald-700' : 'border-rose-500/40 text-rose-700'}>{notice.text}</Badge>}
            <IstClock />
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-cyan-500 to-violet-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </div>

      {statusError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">Backend engine status unavailable: {statusError}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => refreshStatus()}>Retry</Button>
        </div>
      )}

      {/* TABS */}
      <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-border bg-card p-1.5 shadow-sm">
        {TABS.map((t) => {
          const c = tabCount(t.id);
          const activeTab = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all',
                activeTab ? 'bg-gradient-to-r from-cyan-500/20 to-violet-500/20 text-foreground shadow-sm ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <t.icon className={cn('h-3.5 w-3.5', activeTab && 'text-cyan-700')} /> {t.label}
              {c != null && <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] tabular-nums">{c}</span>}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && <OverviewPanel status={status} metrics={metrics.data} resources={resources.data} owner={owner} connected={connected} loading={statusLoading} onRefresh={() => { refreshStatus(); metrics.refresh(); resources.refresh(); }} />}
      {tab === 'flow' && <FlowPanel flow={flow.data} flowError={flow.error} loading={flow.loading} samples={tpsSamples} onRefresh={() => flow.refresh()} />}
      {tab === 'connection' && <ConnectionPanel owner={owner} connected={connected} onAction={connAction} busy={busy} result={connResult} />}
      {tab === 'feed' && <FeedPanel live={live.data} liveError={live.error} loading={live.loading} onRefresh={() => live.refresh()} />}
      {tab === 'quality' && <QualityPanel quality={quality.data} qualityError={quality.error} loading={quality.loading} onRefresh={() => quality.refresh()} />}
      {tab === 'subscriptions' && <SubscriptionsPanel subs={subs.data} loading={subs.loading} onSubscribe={subscribeToken} onUnsubscribe={unsubscribeToken} />}
      {tab === 'pins' && <PinsPanel pins={pins.data} loading={pins.loading} onAdd={addPin} onRemove={removePin} />}
      {tab === 'consumers' && <ConsumersPanel consumers={consumers.data} loading={consumers.loading} onToggle={toggleConsumer} />}
      {tab === 'fields' && <FieldVerificationPanel fv={fv.data} loading={fv.loading} onRefresh={() => fv.refresh()} />}
      {tab === 'raw' && <RawStreamPanel rawData={rawData} rawTok={rawTok} setRawTok={setRawTok} loading={rawLoading} onRefresh={() => void loadRaw()} />}
      {tab === 'resources' && <ResourcesPanel resources={resources.data} loading={resources.loading} onRefresh={() => resources.refresh()} />}
      {tab === 'history' && <HistoryPanel history={history.data} events={events.data} loading={history.loading} onRefreshHistory={() => history.refresh()} onRefreshEvents={() => events.refresh()} />}
      {tab === 'config' && <ConfigPanel config={config.data} loading={config.loading} onRefresh={() => config.refresh()} />}

      <p className="text-[11px] text-muted-foreground">
        Single broker socket (WS#1) owned by backend ws_manager — this page never opens a socket. Tabs fetch lazy (open tab only), cadence throttled (10–30s, hidden paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
