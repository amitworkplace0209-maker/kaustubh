'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Anchor, ArrowDownRight, ArrowLeft, Cable, CheckCircle2, History as HistoryIcon,
  PlugZap, RefreshCw, Router, TriangleAlert, Unplug,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, fmtDuration, fmtNum, fmtTs } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Connections.
 *
 * Calm light-theme surface (one accent per card, plain borders) with real
 * backend data only:
 *  GET /connections
 *    · connections[] — feed links (id, broker, state, times, heartbeats…)
 *    · revision{}    — desired vs applied convergence + per-link lag
 *    · history[]     — restart-safe connection timeline from the DB event
 *                      ledger (websocket up/down, revision bumps, login)
 *    · owner{}       — owner session lifecycle + websocket (feed links
 *                      depend on it) — the reason a feed is down, honestly.
 * Missing = '—'/skeleton, never fake. Throttled cadence (25s, hidden tab paused).
 */

const SM_CONNS = `${SM}/connections`;

type HistoryRow = {
  ts?: string;
  event?: string;
  message?: string;
  status?: string;
  meta?: Record<string, unknown> | null;
  persisted?: boolean;
};

type Owner = {
  state?: string | null;
  stateMessage?: string | null;
  stateSince?: string | null;
  lifecycleState?: string | null;
  websocket?: Record<string, any> | null;
  broker?: string | null;
  mode?: string | null;
};

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

/** Real "status uptime" ticker: how long the link has been in its current state. */
function StateForTicker({ ts, up }: { ts?: string | null; up: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!ts) return <span>—</span>;
  const ms = Date.parse(ts);
  if (isNaN(ms)) return <span className="font-mono">{fmtTs(ts)}</span>;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const dur = s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${fmtDuration(s)}`;
  return (
    <span className="font-mono tabular-nums" title={`${fmtTs(ts)} · duration live derived state transition se`}>
      <span className={up ? 'text-emerald-700' : 'text-rose-700'}>{up ? 'up for' : 'down for'}</span> {dur}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, sub, bar, tint, loading }: {
  icon: React.ElementType; label: string; value: string; sub?: string; bar: string; tint: string; loading?: boolean;
}) {
  return (
    <Card className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5', bar)} />
      <CardContent className="flex items-center gap-3 p-3.5">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', tint)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          {loading ? <div className="mt-1 h-6 w-20 animate-pulse rounded bg-muted/70" /> : <p className="truncate font-mono text-lg font-bold tabular-nums leading-7">{value}</p>}
          <p className="truncate text-[11px] text-muted-foreground">{sub ?? ' '}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SessionManagerConnectionsPage() {
  const con = useOneShot<{ connections?: any[]; revision?: Record<string, any>; history?: HistoryRow[]; owner?: Owner }>(SM_CONNS);
  const { onFrame } = useFrontendRealtime();

  // throttled cadence: 25s, hidden tab paused
  const lastC = useRef(0);
  const conFn = useRef(con.refresh);
  conFn.current = con.refresh;
  useEffect(() => {
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - lastC.current >= 25000) { lastC.current = t; conFn.current(); }
    });
  }, [onFrame]);

  const connections = (con.data?.connections ?? []) as any[];
  const rev = (con.data?.revision ?? {}) as Record<string, any>;
  const history = (con.data?.history ?? []) as HistoryRow[];
  const owner = (con.data?.owner ?? {}) as Owner;
  const desired = Number(rev.desired ?? 0);
  const connectedCount = connections.filter((c) => c.state === 'CONNECTED').length;
  const totalLag = Object.values(rev.lag ?? {}).reduce((s: number, v) => s + Number(v ?? 0), 0);
  const loading = !con.data && !con.error;

  // Owner causality — REAL link between session lifecycle and feed ability.
  const ownerActive = owner.lifecycleState === 'SESSION_ACTIVE' || owner.state === 'SESSION_ACTIVE';
  const ownerWsDown = (owner.websocket?.state ?? 'DISCONNECTED') !== 'CONNECTED';
  const ownerIssue = !ownerActive || ownerWsDown;

  const refreshAll = () => con.refresh();

  const pageError = con.error;

  return (
    <div className="space-y-4 pb-6">
      {/* HERO — calm, single-tint */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-emerald-500/60 via-fuchsia-500/50 to-cyan-500/60" />
        <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-700">
            <Cable className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Connections</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Feed links · revision convergence · DB-backed timeline — owner session ki real dependency ke saath
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('gap-1.5 tabular-nums', connectedCount > 0 ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700')}>
              <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', connectedCount > 0 ? 'animate-pulse bg-emerald-400' : 'bg-rose-400')} />
              {fmtNum(connectedCount)}/{fmtNum(connections.length)} CONNECTED
            </Badge>
            <Badge variant="outline" className="tabular-nums">rev {fmtNum(desired)}</Badge>
            <Badge variant="outline" className={cn('tabular-nums', rev.fully_applied ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/40 bg-amber-500/10 text-amber-700')}>
              {rev.fully_applied ? 'CAUGHT UP' : `DRIFT ${fmtNum(totalLag)}`}
            </Badge>
            <IstClock />
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-cyan-600 to-sky-600 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </div>

      {pageError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">Connections load failed: {pageError} — retry karo, fake data nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => con.refresh()}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP — calm accents */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={Cable} label="Feed links" value={fmtNum(connections.length)} sub={`${fmtNum(connectedCount)} connected`} bar="bg-cyan-500" tint="bg-cyan-500/10" loading={loading} />
        <Kpi icon={PlugZap} label="Live now" value={fmtNum(connectedCount)} sub="state = CONNECTED" bar="bg-emerald-500" tint="bg-emerald-500/10" loading={loading} />
        <Kpi icon={Anchor} label="Revision desired" value={fmtNum(desired)} sub={`latest applied intent · ${rev.fully_applied ? 'fully applied' : 'drift pending'}`} bar="bg-violet-500" tint="bg-violet-500/10" loading={loading} />
        <Kpi icon={ArrowDownRight} label="Apply lag" value={fmtNum(totalLag)} sub={totalLag > 0 ? 'instruments pending on links' : 'all links caught up'} bar={totalLag > 0 ? 'bg-amber-500' : 'bg-emerald-500'} tint={totalLag > 0 ? 'bg-amber-500/10' : 'bg-emerald-500/10'} loading={loading} />
      </div>

      {/* OWNER CAUSALITY — real dependency block */}
      {!loading && (ownerIssue || ownerActive) && (
        <Card className={cn('overflow-hidden border shadow-soft', ownerIssue ? 'border-amber-500/40' : 'border-emerald-500/30')}>
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1.5 p-3 text-xs">
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', ownerIssue ? 'bg-amber-500/10 text-amber-700' : 'bg-emerald-500/10 text-emerald-700')}>
              {ownerIssue ? <TriangleAlert className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              {ownerIssue ? (
                <>
                  <p className="font-semibold text-amber-800">Owner session {String(owner.lifecycleState ?? owner.state ?? '—')} — feed links ispe dependent hain</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {String(owner.stateMessage ?? '')}{owner.websocket?.disconnectReason ? ` · ws reason: ${owner.websocket.disconnectReason}` : ''}
                    {owner.stateSince ? ` · since ${fmtTs(owner.stateSince)}` : ''}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-emerald-800">Owner session active{owner.broker ? ` · ${owner.broker}` : ''}{owner.mode ? ` · ${owner.mode}` : ''}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Feed links subscribe kar sakte hain — lifecycle + websocket healthy.</p>
                </>
              )}
            </div>
            {owner.websocket && (
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className={cn('tabular-nums', owner.websocket.state === 'CONNECTED' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700')}>
                  ws {String(owner.websocket.state ?? '—')}
                </Badge>
                <Badge variant="outline" className="tabular-nums text-muted-foreground">reas {fmtNum(owner.websocket.reconnectCount ?? 0)}</Badge>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* REVISION CONVERGENCE — per link */}
      <Card className="overflow-hidden border shadow-soft">
        <CardHeader className="border-b bg-muted/40 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-violet-500/10 p-1.5 text-violet-700"><Router className="h-3.5 w-3.5" /></span>
            Revision convergence · desired vs applied per link
            <Badge variant="outline" className="ml-auto tabular-nums">desired {fmtNum(desired)}</Badge>
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
                <div key={cid} className="flex items-center gap-2 rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-2 text-[11px]">
                  <span className="w-40 shrink-0 truncate font-mono font-semibold" title={cid}>{cid}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/70">
                    <div className={cn('h-full rounded-full transition-all', lag > 0 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-28 shrink-0 text-right font-mono tabular-nums">{fmtNum(applied)}/{fmtNum(desired)}</span>
                  <Badge variant="outline" className={cn('shrink-0 tabular-nums', lag > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-700' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700')}>lag {fmtNum(lag)}</Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* CONNECTION CARDS — restructured neutral rows */}
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
            const stateTs = live ? c.connected_at : c.disconnected_at;
            return (
              <Card key={cid} className={cn('overflow-hidden border shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg', live ? 'border-emerald-500/30' : 'border-rose-500/30')}>
                <CardHeader className={cn('border-b pb-2', live ? 'border-emerald-500/20 bg-emerald-500/[0.06]' : 'border-rose-500/20 bg-rose-500/[0.05]')}>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={cn('rounded-lg p-1.5', live ? 'bg-emerald-500/10 text-emerald-700' : 'bg-rose-500/10 text-rose-700')}>
                      {live ? <PlugZap className="h-3.5 w-3.5" /> : <Unplug className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-sm" title={cid}>{cid}</span>
                    {c.derived_from && (
                      <Badge variant="outline" className="border-border font-mono text-[9px] text-muted-foreground" title="Mirror registry abhi khali hai (fresh boot) — state live session snapshot se derived, sab values real">
                        derived
                      </Badge>
                    )}
                    <Badge variant="outline" className={cn('tabular-nums', live ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/40 bg-rose-500/10 text-rose-700')}>
                      <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', live && 'animate-pulse bg-emerald-400')} />{String(c.state ?? 'UNKNOWN')}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pt-3 text-xs">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Broker</p>
                      <p className="truncate font-mono font-semibold">{c.broker ?? '—'}</p>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Feed tier · reconnects</p>
                      <p className="flex items-center gap-1.5 font-mono font-semibold">
                        {c.feed_level ?? '—'} <span className="text-muted-foreground">· {fmtNum(c.reconnect_count)}</span>
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1.5 rounded-lg border border-border/60 bg-black/[0.02] p-2.5">
                    <p className="flex items-start justify-between gap-2">
                      <span className="shrink-0 font-semibold">Current state</span>
                      <StateForTicker ts={stateTs} up={live} />
                    </p>
                    <p className="flex items-start justify-between gap-2">
                      <span className="shrink-0 font-semibold">Heartbeat</span>
                      <span className="font-mono tabular-nums">{c.last_heartbeat ? fmtTs(c.last_heartbeat) : '—'}</span>
                    </p>
                    <p className="flex items-start justify-between gap-2">
                      <span className="shrink-0 font-semibold">Applied revision</span>
                      <span className="font-mono tabular-nums">{fmtNum(c.last_applied_revision)}{lag > 0 ? <span className="ml-1 text-amber-700">· lag {fmtNum(lag)}</span> : <span className="ml-1 text-emerald-700">· caught up</span>}</span>
                    </p>
                    {c.reason && <p className="flex items-start justify-between gap-2"><span className="shrink-0 font-semibold">Reason</span><span className="truncate font-mono text-muted-foreground" title={c.reason}>{c.reason}</span></p>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* CONNECTION TIMELINE — DB-backed, restart-safe */}
      <Card className="overflow-hidden border shadow-soft">
        <CardHeader className="border-b bg-muted/40 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-slate-500/10 p-1.5 text-slate-700"><HistoryIcon className="h-3.5 w-3.5" /></span>
            Connection timeline · DB ledger (restart-safe)
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(Math.min(history.length, 40))} events</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 pt-0">
          {!con.data && !pageError ? (
            <div className="space-y-1.5 p-3">{[0, 1, 2, 3].map((i) => <div key={i} className="h-7 animate-pulse rounded-lg bg-muted/60" />)}</div>
          ) : !history.length ? (
            <p className="py-4 text-center text-[11px] text-muted-foreground">Timeline khali — ledger me abhi koi connection event nahi.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <tbody>
                  {history.slice(0, 40).map((e, i) => {
                    const ev = String(e.event ?? 'EVENT');
                    const kindOf = ev.startsWith('WEBSOCKET_')
                      ? /CONNECTED(?!_)/.test(ev) ? 'up' : 'down'
                      : ev.startsWith('SUBSCRIPTIONS_') ? 'rev'
                      : ev.startsWith('LOGIN') ? 'login'
                      : ev.startsWith('STATE:') ? 'state' : 'other';
                    const dot = kindOf === 'down' ? 'bg-rose-500' : kindOf === 'up' || kindOf === 'login' ? 'bg-emerald-500' : kindOf === 'rev' ? 'bg-violet-500' : kindOf === 'state' ? 'bg-sky-500' : 'bg-slate-400';
                    const revision = (e.meta as any)?.revision;
                    return (
                      <tr key={`${e.ts}-${ev}-${i}`} className={cn('border-b border-border/40 last:border-0 transition-colors', kindOf === 'down' ? 'bg-rose-500/[0.03]' : kindOf === 'rev' ? 'bg-violet-500/[0.03]' : 'hover:bg-black/[0.02]')}>
                        <td className="w-[9px] px-2 py-1.5"><span className={cn('mx-auto block h-1.5 w-1.5 rounded-full', dot)} /></td>
                        <td className="whitespace-nowrap px-1 py-1.5 font-mono text-[10px] text-muted-foreground">{fmtTs(e.ts)}</td>
                        <td className="px-2 py-1.5">
                          <span className="truncate font-mono font-semibold" title={ev}>{ev.replace('SESSION_', '').replace('WEBSOCKET_', 'WS_').slice(0, 38)}</span>
                          {e.message && <span className="ml-1.5 text-[10px] text-muted-foreground" title={e.message}>{e.message}</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {revision != null && <Badge variant="outline" className="mr-1.5 border-violet-500/40 bg-violet-500/10 font-mono text-[9px] font-semibold tabular-nums text-violet-700">r{String(revision)}</Badge>}
                          {e.persisted === false && <Badge variant="outline" className="border-border font-mono text-[9px] text-muted-foreground">memory</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Source: <span className="font-mono">GET /connections</span> — links + revision real snapshot se · timeline <span className="font-mono">system_events</span> ledger se (restart-safe) · owner state live session snapshot se. State-for tickers derived hain (state transition timestamps). Auto-refresh throttled (25s, hidden tab paused). Missing = '—', fake kabhi nahi.
      </p>
    </div>
  );
}
