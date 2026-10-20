'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Anchor, ArrowLeft, Cable, CheckCircle2, History as HistoryIcon,
  PlugZap, RefreshCw, Router, Unplug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, TONE, fmtNum, fmtTs, tierBadge } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Connections — redesigned from zero.
 *
 * Kaun / kab / kaise Session Manager se connect hua + subscribe/unsubscribe:
 *  GET /connections → feed links (connection_id, broker, state, connected_at,
 *  disconnected_at, reason, reconnects, feed_level, applied revision,
 *  heartbeat) + revision intent (desired/applied/lag/fully_applied).
 *  GET /events → subscribe/unsubscribe lifecycle audit (kab kya hua).
 * Real backend state only — missing = '—', never fake. Throttled cadence.
 */

const SM_CONNS = `${SM}/connections`;
const SM_EVENTS = `${SM}/events?limit=60`;

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

/** Live "x ago" ticker — isolated so the page never re-renders every second. */
function AgeTicker({ ts }: { ts?: string | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!ts) return <span>—</span>;
  const ms = Date.parse(ts);
  if (isNaN(ms)) return <span className="font-mono">{fmtTs(ts)}</span>;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const age = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s ago` : `${Math.floor(s / 3600)}h ago`;
  return <span className="font-mono tabular-nums" title={fmtTs(ts)}>{fmtTs(ts)} · {age}</span>;
}

export default function SessionManagerConnectionsPage() {
  const con = useOneShot<{ connections?: any[]; revision?: Record<string, any> }>(SM_CONNS);
  const evt = useOneShot<any[]>(SM_EVENTS);
  const { onFrame } = useFrontendRealtime();

  // throttled cadence: connections 25s, events 60s, hidden tab paused
  const lastC = useRef(0);
  const lastE = useRef(0);
  const conFn = useRef(con.refresh);
  const evtFn = useRef(evt.refresh);
  conFn.current = con.refresh;
  evtFn.current = evt.refresh;
  useEffect(() => {
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - lastC.current >= 25000) { lastC.current = t; conFn.current(); }
      if (t - lastE.current >= 60000) { lastE.current = t; evtFn.current(); }
    });
  }, [onFrame]);

  const connections = (con.data?.connections ?? []) as any[];
  const rev = (con.data?.revision ?? {}) as Record<string, any>;
  const desired = Number(rev.desired ?? 0);
  const connectedCount = connections.filter((c) => c.state === 'CONNECTED').length;
  const loading = !con.data && !con.error;

  // subscribe / unsubscribe audit — kab kya hua (real lifecycle events)
  const audit = useMemo(() => {
    const rows = (Array.isArray(evt.data) ? evt.data : []) as any[];
    const interesting = rows.filter((e) => {
      const ev = String(e.event ?? e.event_type ?? '').toUpperCase();
      return ev.includes('SUBSCR') || ev.includes('STOCK_') || ev.includes('SESSION_') || ev.includes('RECONCILE') || ev.includes('REVISION') || ev.includes('CONNECT');
    });
    return interesting.slice(0, 15);
  }, [evt.data]);

  const refreshAll = () => { con.refresh(); evt.refresh(); };

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-cyan-500/[0.12] via-primary/[0.06] to-amber-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-amber-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 via-primary to-amber-500 text-white shadow-xl">
            <Cable className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Connections</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Kaun · kab · kaise connect hua — feed links, revision convergence + subscribe/unsubscribe audit
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={connectedCount > 0 ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-200' : 'border border-rose-500/40 bg-rose-500/10 text-rose-200'}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', connectedCount > 0 ? 'animate-pulse bg-emerald-400' : 'bg-rose-400')} />
              {fmtNum(connectedCount)}/{fmtNum(connections.length)} CONNECTED
            </Badge>
            <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 tabular-nums text-violet-300">rev {fmtNum(rev.desired)}</Badge>
            <Badge variant="outline" className={rev.fully_applied ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}>
              {rev.fully_applied ? 'CAUGHT UP' : 'APPLYING'}
            </Badge>
            <IstClock />
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-cyan-500 to-amber-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        <div className="relative flex h-2 w-full overflow-hidden bg-muted/60">
          {connections.length > 0 && connections.map((c: any) => (
            <span key={c.connection_id ?? c.id} className={cn('h-full transition-all', c.state === 'CONNECTED' ? 'bg-gradient-to-r from-emerald-500 to-emerald-400' : 'bg-gradient-to-r from-rose-500 to-rose-400')} style={{ width: `${100 / connections.length}%` }} />
          ))}
        </div>
      </div>

      {con.error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <span className="min-w-0">Connections load failed: {con.error} — retry karo, fake data nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => con.refresh()}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          { icon: Cable, label: 'Feed links', value: fmtNum(connections.length), sub: `${fmtNum(connectedCount)} connected`, bar: 'bg-cyan-400', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-lg shadow-cyan-500/25', tone: '' },
          { icon: PlugZap, label: 'Live now', value: fmtNum(connectedCount), sub: 'state = CONNECTED', bar: 'bg-emerald-400', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25', tone: 'text-emerald-300' },
          { icon: Anchor, label: 'Revision desired', value: fmtNum(rev.desired), sub: 'intent revision', bar: 'bg-violet-400', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25', tone: 'text-violet-300' },
          { icon: CheckCircle2, label: 'Fully applied', value: String(rev.fully_applied ?? '—'), sub: 'all links caught up', bar: rev.fully_applied ? 'bg-emerald-400' : 'bg-amber-400', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25', tone: rev.fully_applied ? 'text-emerald-300' : 'text-amber-300' },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
            <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', k.bar)} />
            <CardContent className="flex items-center gap-3 p-3.5">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', k.chip)}><k.icon className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
                {loading ? <div className="mt-1 h-7 w-20 animate-pulse rounded bg-muted/70" /> : <p className={cn('truncate font-mono text-xl font-bold tabular-nums leading-7', k.tone)}>{k.value}</p>}
                <p className="truncate text-[11px] text-muted-foreground">{k.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* REVISION CONVERGENCE CHART */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-cyan-500/10 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-cyan-600 p-1.5 text-white shadow"><Router className="h-3.5 w-3.5" /></span>
            Revision convergence · desired vs applied
            <Badge variant="outline" className="ml-auto tabular-nums">desired {fmtNum(rev.desired)}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 pt-3">
          {loading ? (
            <div className="space-y-1.5">{[0, 1].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/60" />)}</div>
          ) : !connections.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No feed connections — backend ne koi link report nahi kiya.</p>
          ) : (
            connections.map((c: any) => {
              const cid = c.connection_id ?? c.id ?? '—';
              const applied = Number(c.last_applied_revision ?? 0);
              const lag = Number(rev.lag?.[c.connection_id] ?? rev.lag?.[c.id] ?? Math.max(0, desired - applied));
              const pct = desired > 0 ? Math.max(0, Math.min(100, (applied / desired) * 100)) : (lag === 0 ? 100 : 0);
              return (
                <div key={cid} className="flex items-center gap-2 rounded-lg border border-border/50 bg-white/[0.02] px-2.5 py-2 text-[11px]">
                  <span className="w-40 shrink-0 truncate font-mono font-semibold" title={cid}>{cid}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted/70">
                    <div className={cn('h-full rounded-full transition-all', lag > 0 ? 'bg-gradient-to-r from-amber-500 to-amber-400' : 'bg-gradient-to-r from-emerald-500 to-emerald-400')} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-28 shrink-0 text-right font-mono tabular-nums">{fmtNum(applied)}/{fmtNum(desired)}</span>
                  <Badge variant="outline" className={cn('shrink-0 tabular-nums', lag > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300')}>lag {fmtNum(lag)}</Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* CONNECTION CARDS — kaun/kab/kaise */}
      {loading ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {[0, 1].map((i) => <div key={i} className="h-52 animate-pulse rounded-2xl bg-muted/60" />)}
        </div>
      ) : !connections.length ? (
        <p className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">No connections.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {connections.map((c: any) => {
            const cid = c.connection_id ?? c.id ?? '—';
            const live = c.state === 'CONNECTED';
            const lag = Number(rev.lag?.[c.connection_id] ?? rev.lag?.[c.id] ?? 0);
            return (
              <Card key={cid} className={cn('overflow-hidden border shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg', live ? 'border-emerald-500/25' : 'border-rose-500/25')}>
                <CardHeader className={cn('pb-2', live ? 'bg-gradient-to-r from-emerald-500/10 to-cyan-500/5' : 'bg-gradient-to-r from-rose-500/10 to-amber-500/5')}>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={cn('rounded-lg p-1.5 text-white shadow', live ? 'bg-gradient-to-br from-emerald-500 to-cyan-600' : 'bg-gradient-to-br from-rose-500 to-amber-600')}>
                      {live ? <PlugZap className="h-3.5 w-3.5" /> : <Unplug className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-sm" title={cid}>{cid}</span>
                    <Badge variant="outline" className={live ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' : 'border-rose-500/40 bg-rose-500/15 text-rose-200'}>
                      <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', live && 'animate-pulse bg-emerald-400')} />{String(c.state ?? 'UNKNOWN')}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 pt-3 text-[11px]">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-sky-500/25 bg-gradient-to-b from-sky-500/10 to-transparent px-2.5 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-sky-300/80">Kaun · broker</p>
                      <p className="truncate font-mono text-sm font-semibold">{c.broker ?? '—'}</p>
                      <div className="mt-1">{tierBadge(c.feed_level)}</div>
                    </div>
                    <div className="rounded-xl border border-violet-500/25 bg-gradient-to-b from-violet-500/10 to-transparent px-2.5 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-violet-300/80">Kaise · reconnects</p>
                      <p className="font-mono text-sm font-semibold tabular-nums">{fmtNum(c.reconnect_count)}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">rev {fmtNum(c.last_applied_revision)}{lag > 0 ? ` · lag ${fmtNum(lag)}` : ' · caught up'}</p>
                    </div>
                  </div>
                  <div className="space-y-1 rounded-xl border border-border/50 bg-white/[0.02] p-2.5 text-muted-foreground">
                    <p className="flex items-start justify-between gap-2"><span className="shrink-0 font-semibold text-foreground">Connected (kab)</span><AgeTicker ts={c.connected_at} /></p>
                    <p className="flex items-start justify-between gap-2"><span className="shrink-0 font-semibold text-foreground">Disconnected</span><AgeTicker ts={c.disconnected_at} /></p>
                    {c.reason && <p className="truncate">reason <span className="font-mono text-foreground">{c.reason}</span></p>}
                    <p className="flex items-start justify-between gap-2"><span className="shrink-0 font-semibold text-foreground">Heartbeat</span><AgeTicker ts={c.last_heartbeat} /></p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* SUBSCRIBE / UNSUBSCRIBE AUDIT — kab kya hua */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-fuchsia-500/10 to-pink-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-600 p-1.5 text-white shadow"><HistoryIcon className="h-3.5 w-3.5" /></span>
            Subscribe / unsubscribe audit · kab kya hua
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(audit.length)} events</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {!evt.data && !evt.error ? (
            <div className="space-y-1.5">{[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/60" />)}</div>
          ) : evt.error ? (
            <p className="py-3 text-center text-xs text-rose-300">Audit unavailable: {evt.error}</p>
          ) : !audit.length ? (
            <p className="py-4 text-center text-[11px] text-muted-foreground">Abhi koi subscribe/unsubscribe event nahi — registry steady hai.</p>
          ) : (
            <div className="max-h-[320px] space-y-1 overflow-y-auto">
              {audit.map((e: any, i: number) => {
                const ev = String(e.event ?? e.event_type ?? 'event');
                const sub = ev.toUpperCase().includes('UNSUBSCR');
                return (
                  <div key={e._id ?? i} className={cn('flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px]', sub ? 'border-rose-500/25 bg-rose-500/[0.04]' : 'border-emerald-500/25 bg-emerald-500/[0.04]')}>
                    <Badge variant="outline" className={cn('shrink-0 font-mono text-[9px]', TONE[e.severity ?? ''] ?? (sub ? 'border-rose-500/30 text-rose-300' : 'border-emerald-500/30 text-emerald-300'))}>{ev.toUpperCase().slice(0, 22)}</Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={e.instrument_id ?? e.instrument_key}>{e.instrument_id ?? e.instrument_key ?? e.message ?? e.details ?? '—'}</span>
                    {e.revision != null && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">rev {fmtNum(e.revision)}</span>}
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtTs(e.ts ?? e.timestamp ?? e.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Sources: <span className="font-mono">GET /connections · GET /events</span> — sab real backend state. Heartbeat/disconnect age live tickers hain (backend timestamps se derived). Auto-refresh throttled (25s/60s, hidden tab paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
