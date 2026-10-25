'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity, Anchor, ArrowLeft, CheckCircle2, Copy, Cpu, Gauge,
  HardDrive, RefreshCw, ShieldCheck, Wrench, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, CONFIG_LABELS, fmtNum } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Diagnostics — redesigned from zero, full features.
 *
 * GET /api/phase3/session-manager/diagnostics — engine registry, session
 * health + checklist, revision drift chart, MongoDB, effective config (copy),
 * event distribution chart, connections, last REST error. Real backend state
 * only, throttled WS#2 cadence (30s).
 */

const SM_DIAG = `${SM}/diagnostics`;

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

export default function SessionManagerDiagnosticsPage() {
  const { data, error, refresh } = useOneShot<Record<string, any>>(SM_DIAG);
  const { onFrame } = useFrontendRealtime();
  const [copied, setCopied] = useState(false);

  const last = useRef(0);
  const fn = useRef(refresh);
  fn.current = refresh;
  useEffect(() => {
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < 30000) return;
      last.current = t;
      fn.current();
    });
  }, [onFrame]);

  const engines = Object.entries((data?.engines ?? {}) as Record<string, any>);
  const sh = (data?.sessionHealth ?? {}) as Record<string, any>;
  const rev = (data?.revisionStatus ?? {}) as Record<string, any>;
  const mongo = (data?.mongo ?? {}) as Record<string, any>;
  const cfg = (data?.config ?? {}) as Record<string, any>;
  const eventCounts = (data?.recentSessionEvents ?? {}) as Record<string, number>;
  const conns = (data?.connections ?? []) as any[];
  const smEngine = (engines.find(([eid]) => eid === 'session_manager')?.[1] ?? {}) as Record<string, any>;

  const loading = !data && !error;
  const healthy = Boolean(sh.ok);
  const reasons = (sh.reasons ?? []) as string[];
  const checks: { label: string; pass: boolean; detail?: string }[] = [
    { label: 'Session active', pass: sh.active !== false, detail: String(sh.state ?? '') },
    { label: 'WebSocket link', pass: sh.websocket === 'CONNECTED', detail: String(sh.websocket ?? '—') },
    { label: 'Feed connection up', pass: Boolean(sh.connection_connected), detail: sh.connection_connected ? 'linked' : 'down' },
    { label: 'No revision drift', pass: !sh.revision_drift, detail: sh.revision_drift ? 'intent not applied' : 'converged' },
    { label: 'MongoDB reachable', pass: Boolean(mongo.connected), detail: mongo.connected ? 'connected' : 'down' },
  ];

  const maxEvt = Math.max(1, ...Object.values(eventCounts).map(Number));
  const copyJson = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', healthy ? 'from-emerald-500/[0.12] via-primary/[0.06] to-cyan-500/[0.12]' : 'from-amber-500/[0.12] via-primary/[0.06] to-rose-500/[0.12]')} />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className={cn('flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-xl', healthy ? 'bg-gradient-to-br from-emerald-500 via-primary to-cyan-500' : 'bg-gradient-to-br from-amber-500 via-primary to-rose-500')}>
            <Cpu className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Diagnostics</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Engine registry · health checklist · revision drift · mongo · config — live backend state
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!loading && !error && (
              <Badge className={healthy ? 'border border-emerald-500/40 bg-gradient-to-r from-emerald-500/25 to-emerald-500/10 text-emerald-800' : 'border border-amber-500/40 bg-gradient-to-r from-amber-500/25 to-amber-500/10 text-amber-800'}>
                <span className={cn('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', healthy ? 'animate-pulse bg-emerald-400' : 'bg-amber-400')} />
                {healthy ? 'HEALTHY' : 'DEGRADED'}
              </Badge>
            )}
            <IstClock />
            <Button size="sm" variant="outline" onClick={copyJson} disabled={!data} className="gap-1.5">
              {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy JSON'}
            </Button>
            <Button size="sm" onClick={() => refresh()} className="gap-1.5 bg-gradient-to-r from-emerald-500 to-cyan-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">Diagnostics load failed: {error} — retry karo, fake health nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => refresh()}>Retry</Button>
        </div>
      )}
      {data?.lastRestError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-700">
          last REST error: <span className="font-mono">{String(data.lastRestError)}</span>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          { icon: Cpu, label: 'Session engine', value: String(smEngine.state ?? '—'), sub: 'registry live state', bar: 'bg-cyan-400', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-lg shadow-cyan-500/25', tone: '' },
          { icon: ShieldCheck, label: 'Session health', value: loading ? '…' : healthy ? 'HEALTHY' : 'DEGRADED', sub: reasons[0] ?? (data ? 'no problems reported' : 'waiting for backend'), bar: healthy ? 'bg-emerald-400' : 'bg-amber-400', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25', tone: healthy ? 'text-emerald-700' : 'text-amber-700' },
          { icon: HardDrive, label: 'MongoDB', value: loading ? '…' : mongo.connected ? 'CONNECTED' : 'DOWN', sub: String(cfg?.collection ?? 'session_manager_config'), bar: mongo.connected ? 'bg-emerald-400' : 'bg-rose-400', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25', tone: mongo.connected ? 'text-emerald-700' : 'text-rose-700' },
          { icon: Wrench, label: 'Revision drift', value: loading ? '…' : rev.fully_applied ? 'APPLIED' : 'DRIFT', sub: `desired ${fmtNum(rev.desired)}`, bar: rev.fully_applied ? 'bg-emerald-400' : 'bg-amber-400', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25', tone: rev.fully_applied ? 'text-emerald-700' : 'text-amber-700' },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
            <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', k.bar)} />
            <CardContent className="flex items-center gap-3 p-3.5">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', k.chip)}><k.icon className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
                {loading ? <div className="mt-1 h-7 w-24 animate-pulse rounded bg-muted/70" /> : <p className={cn('truncate font-mono text-lg font-bold tabular-nums leading-7', k.tone)} title={String(k.value)}>{k.value}</p>}
                <p className="truncate text-[11px] text-muted-foreground" title={k.sub}>{k.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* HEALTH CHECKLIST + REVISION */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-cyan-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 p-1.5 text-white shadow"><ShieldCheck className="h-3.5 w-3.5" /></span>
              Health checklist · real reasons
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {loading ? (
              <div className="space-y-1.5">{[0, 1, 2, 3].map((i) => <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/60" />)}</div>
            ) : (
              <>
                {checks.map((c) => (
                  <div key={c.label} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs', c.pass ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-rose-500/30 bg-rose-500/[0.06]')}>
                    {c.pass ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : <XCircle className="h-4 w-4 shrink-0 text-rose-400" />}
                    <span className="font-medium">{c.label}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">{c.detail}</span>
                  </div>
                ))}
                {reasons.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2 text-[11px] text-amber-700">
                    backend reasons: {reasons.join('; ')}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-violet-500/10 to-purple-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 p-1.5 text-white shadow"><Anchor className="h-3.5 w-3.5" /></span>
              Revision drift · desired vs lag
              <Badge variant="outline" className="ml-auto tabular-nums">desired {fmtNum(rev.desired)}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {loading ? (
              <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
            ) : (
              <>
                <div className={cn('rounded-lg border px-2.5 py-2 text-xs font-semibold', rev.fully_applied ? 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-700' : 'border-amber-500/30 bg-amber-500/[0.06] text-amber-700')}>
                  {rev.fully_applied ? 'All connections caught up — intent fully applied.' : 'Drift — intent har connection par apply nahi hua.'}
                </div>
                {Object.entries((rev.lag ?? {}) as Record<string, number>).map(([cid, lag]) => (
                  <div key={cid} className="flex items-center gap-2 rounded-lg border border-border/50 bg-white/[0.02] px-2.5 py-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate font-mono" title={cid}>{cid}</span>
                    <Badge variant="outline" className={cn('tabular-nums', Number(lag) > 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-700' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700')}>lag {fmtNum(lag)}</Badge>
                  </div>
                ))}
                {!Object.keys(rev.lag ?? {}).length && <p className="py-2 text-center text-[11px] text-muted-foreground">No per-connection lag reported.</p>}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ENGINE REGISTRY */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-cyan-500/10 to-sky-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-cyan-500 to-sky-600 p-1.5 text-white shadow"><Cpu className="h-3.5 w-3.5" /></span>
            Engine registry · session_manager + dependencies
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(engines.length)} engines</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {loading ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/60" />)}</div>
          ) : !engines.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No engines reported (registry unavailable).</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {engines.map(([eid, e]: [string, any]) => {
                const running = e.state === 'RUNNING';
                return (
                  <div key={eid} className={cn('rounded-xl border p-3 transition-colors hover:border-primary/40', running ? 'border-emerald-500/25 bg-emerald-500/[0.03]' : 'border-border/50 bg-white/[0.02]')}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-bold">{eid}</span>
                      <Badge variant="outline" className={running ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800' : ''}>{String(e.state ?? '—')}</Badge>
                      <Badge variant="outline" className={e.health === 'HEALTHY' ? 'border-emerald-500/30 text-emerald-700' : e.health === 'DEGRADED' ? 'border-amber-500/30 text-amber-700' : ''}>{String(e.health ?? '—')}</Badge>
                      {e.managed && <Badge variant="outline" className="text-[10px]">managed</Badge>}
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">v{e.version ?? '—'} · hb {e.heartbeatAge != null ? `${e.heartbeatAge}s ago` : '—'}</span>
                    </div>
                    {e.healthReason && <p className="mt-1 text-[11px] text-muted-foreground">{e.healthReason}</p>}
                    {(e.recentErrors ?? []).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(e.recentErrors ?? []).map((er: any, i: number) => (
                          <Badge key={i} variant="outline" className="border-rose-500/30 bg-rose-500/10 text-[10px] text-rose-700">{String(er?.error ?? er)}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* CONFIG + EVENTS */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-amber-500/10 to-orange-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 p-1.5 text-white shadow"><Gauge className="h-3.5 w-3.5" /></span>
              Effective configuration · live
              <Badge variant="outline" className={cn('ml-auto', String(cfg.cacheSource) === 'mongo' ? 'border-emerald-500/30 text-emerald-700' : '')}>cache {String(cfg.cacheSource ?? '—')}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3 text-xs">
            {loading ? <div className="h-16 animate-pulse rounded-lg bg-muted/60" /> : (
              <>
                {Object.entries(cfg?.effective ?? {}).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 rounded-lg border-b border-border/40 px-2 py-1.5">
                    <span className="text-muted-foreground">{CONFIG_LABELS[k]?.label ?? k}</span>
                    <span className="font-mono font-semibold tabular-nums">{String(v)}s</span>
                  </div>
                ))}
                {!Object.keys(cfg?.effective ?? {}).length && <p className="text-muted-foreground">Config unavailable.</p>}
              </>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="bg-gradient-to-r from-fuchsia-500/10 to-pink-500/5 pb-2">
            <CardTitle className="flex items-center gap-2 text-xs">
              <span className="rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-600 p-1.5 text-white shadow"><Activity className="h-3.5 w-3.5" /></span>
              Recent session events · distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-3">
            {loading ? <div className="h-16 animate-pulse rounded-lg bg-muted/60" /> : (
              <>
                {Object.entries(eventCounts).sort((a, b) => Number(b[1]) - Number(a[1])).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 text-[11px]">
                    <span className="w-44 shrink-0 truncate font-mono text-emerald-700" title={k}>{k}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/70">
                      <div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-pink-400" style={{ width: `${(Number(v) / maxEvt) * 100}%` }} />
                    </div>
                    <span className="w-12 shrink-0 text-right font-mono tabular-nums">{String(v)}</span>
                  </div>
                ))}
                {!Object.keys(eventCounts).length && <p className="text-muted-foreground">No events in the ring.</p>}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {conns.length > 0 && (
        <Card className="overflow-hidden shadow-soft">
          <CardHeader className="pb-2"><CardTitle className="text-xs">Connections snapshot</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-xs">
            {conns.map((c: any) => (
              <div key={c.connection_id ?? c.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/40 px-2.5 py-1.5">
                <span className="font-mono font-semibold">{c.connection_id ?? c.id}</span>
                <Badge variant="outline" className={c.state === 'CONNECTED' ? 'border-emerald-500/30 text-emerald-700' : 'border-rose-500/30 text-rose-700'}>{String(c.state ?? '—')}</Badge>
                <span className="ml-auto font-mono text-muted-foreground">applied {fmtNum(c.last_applied_revision)} · broker {c.broker ?? '—'}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        Source: <span className="font-mono">GET /api/phase3/session-manager/diagnostics</span> — sab real backend state. Auto-refresh throttled (30s, hidden tab paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
