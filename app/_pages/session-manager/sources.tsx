'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Database, Filter, Layers, RefreshCw, Search, Trophy,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, fmtNum } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Sources — redesigned from zero.
 *
 * Real data only: GET /api/phase3/session-manager/sources — canonical
 * instruments bucketed by real origin source ({ count, symbols[] }) + total.
 * Missing = '—'/skeleton, never fake. Throttled WS#2 cadence (30s).
 */

const SM_SOURCES = `${SM}/sources`;

const PALETTE = [
  { bar: '#34d399', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-emerald-500/25', soft: 'border-emerald-500/30 bg-gradient-to-b from-emerald-500/15 to-transparent' },
  { bar: '#22d3ee', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-cyan-500/25', soft: 'border-cyan-500/30 bg-gradient-to-b from-cyan-500/15 to-transparent' },
  { bar: '#a78bfa', chip: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-violet-500/25', soft: 'border-violet-500/30 bg-gradient-to-b from-violet-500/15 to-transparent' },
  { bar: '#fbbf24', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-amber-500/25', soft: 'border-amber-500/30 bg-gradient-to-b from-amber-500/15 to-transparent' },
  { bar: '#fb7185', chip: 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-rose-500/25', soft: 'border-rose-500/30 bg-gradient-to-b from-rose-500/15 to-transparent' },
  { bar: '#38bdf8', chip: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-sky-500/25', soft: 'border-sky-500/30 bg-gradient-to-b from-sky-500/15 to-transparent' },
  { bar: '#e879f9', chip: 'bg-gradient-to-br from-fuchsia-500 to-pink-600 text-white shadow-fuchsia-500/25', soft: 'border-fuchsia-500/30 bg-gradient-to-b from-fuchsia-500/15 to-transparent' },
  { bar: '#2dd4bf', chip: 'bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-teal-500/25', soft: 'border-teal-500/30 bg-gradient-to-b from-teal-500/15 to-transparent' },
];

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

export default function SessionManagerSourcesPage() {
  const { data, error, refresh } = useOneShot<{ sources?: Record<string, { count: number; symbols?: string[] }>; total?: number }>(SM_SOURCES);
  const { onFrame } = useFrontendRealtime();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // throttled cadence: max 1 refresh / 30s, hidden tab paused
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

  const buckets = useMemo(() => {
    const src = data?.sources ?? {};
    return Object.entries(src)
      .map(([name, b]: [string, any]) => ({ name, count: Number(b?.count ?? 0), symbols: (b?.symbols ?? []) as string[] }))
      .sort((a, b) => b.count - a.count);
  }, [data?.sources]);

  const total = Number(data?.total ?? buckets.reduce((s, b) => s + b.count, 0));
  const top = buckets[0] ?? null;
  const avg = buckets.length ? total / buckets.length : null;

  const qq = q.trim().toLowerCase();
  const filtered = qq
    ? buckets.filter((b) => b.name.toLowerCase().includes(qq) || b.symbols.some((s) => s.toLowerCase().includes(qq))).map((b) => ({
      ...b,
      symbols: b.symbols.filter((s) => !qq || b.name.toLowerCase().includes(qq) || s.toLowerCase().includes(qq)),
    }))
    : buckets;

  const loading = !data && !error;

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.12] via-primary/[0.06] to-cyan-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-violet-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-primary to-cyan-500 text-white shadow-xl">
            <Filter className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Sources</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Instruments bucketed by real origin source · <span className="font-mono font-semibold text-foreground">{fmtNum(data?.total)}</span> total
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 tabular-nums text-violet-300">{fmtNum(buckets.length)} sources</Badge>
            <IstClock />
            <Button size="sm" onClick={() => refresh()} className="gap-1.5 bg-gradient-to-r from-violet-500 to-cyan-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        <div className="relative flex h-2 w-full overflow-hidden bg-muted/60">
          {total > 0 && buckets.slice(0, 8).map((b, i) => (
            <span key={b.name} className="h-full transition-all" style={{ width: `${(b.count / total) * 100}%`, background: PALETTE[i % PALETTE.length].bar }} />
          ))}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <span className="min-w-0">Sources load failed: {error} — retry karo, fake data nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => refresh()}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          { icon: Database, label: 'Total instruments', value: fmtNum(data?.total), sub: 'canonical registry', i: 0 },
          { icon: Layers, label: 'Sources', value: fmtNum(buckets.length), sub: 'distinct origins', i: 1 },
          { icon: Trophy, label: 'Top source', value: top ? `${top.name} · ${fmtNum(top.count)}` : '—', sub: top && total ? `${((top.count / Math.max(1, total)) * 100).toFixed(1)}% share` : undefined, i: 2 },
          { icon: Filter, label: 'Avg / source', value: avg != null ? fmtNum(Math.round(avg)) : '—', sub: 'mean bucket size', i: 3 },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
            <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: PALETTE[k.i % PALETTE.length].bar }} />
            <CardContent className="flex items-center gap-3 p-3.5">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-lg', PALETTE[k.i % PALETTE.length].chip)}>
                <k.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
                {loading ? <div className="mt-1 h-7 w-24 animate-pulse rounded bg-muted/70" /> : <p className="truncate font-mono text-lg font-bold tabular-nums leading-7" title={String(k.value)}>{k.value}</p>}
                <p className="truncate text-[11px] text-muted-foreground">{k.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* DISTRIBUTION CHART */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-cyan-500/10 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-cyan-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
            Distribution · share chart
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(total)} instruments</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 pt-3">
          {loading ? (
            <div className="space-y-1.5">{[0, 1, 2].map((i) => <div key={i} className="h-7 animate-pulse rounded-lg bg-muted/60" />)}</div>
          ) : !buckets.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No instruments yet — no source data.</p>
          ) : (
            buckets.slice(0, 10).map((b, i) => {
              const pct = total ? (b.count / total) * 100 : 0;
              return (
                <div key={b.name} className="flex items-center gap-2 text-[11px]">
                  <span className="w-36 shrink-0 truncate font-mono font-semibold" title={b.name}>{b.name}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted/70">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${PALETTE[i % PALETTE.length].bar}, ${PALETTE[i % PALETTE.length].bar}cc)` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono tabular-nums">{fmtNum(b.count)}</span>
                  <span className="w-12 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* FILTER + CARDS */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by source / symbol…" className="pl-9" />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-36 animate-pulse rounded-2xl bg-muted/60" />)}
        </div>
      ) : !filtered.length ? (
        <p className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {buckets.length ? `No match for "${q}".` : 'No instruments yet — no source data.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((b) => {
            const c = PALETTE[buckets.findIndex((x) => x.name === b.name) % PALETTE.length];
            const open = expanded === b.name;
            const shown = open ? b.symbols : b.symbols.slice(0, 12);
            return (
              <Card key={b.name} className={cn('group overflow-hidden border shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg', c.soft)}>
                <CardHeader className="pb-1">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <span className={cn('rounded-lg p-1.5 shadow', c.chip)}><Filter className="h-3.5 w-3.5" /></span>
                    <span className="min-w-0 flex-1 truncate" title={b.name}>{b.name}</span>
                    <span className="font-mono text-lg font-bold tabular-nums">{fmtNum(b.count)}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted/70">
                    <div className="h-full rounded-full" style={{ width: `${total ? (b.count / total) * 100 : 0}%`, background: c.bar }} />
                  </div>
                  <div className="mt-2 flex min-h-[52px] flex-wrap gap-1">
                    {shown.map((s) => (
                      <Badge key={s} variant="outline" className="font-mono text-[10px]">{s}</Badge>
                    ))}
                    {!shown.length && <span className="text-[11px] text-muted-foreground">—</span>}
                  </div>
                  {b.symbols.length > 12 && (
                    <button onClick={() => setExpanded(open ? null : b.name)} className="mt-1.5 text-[11px] font-medium text-primary hover:underline">
                      {open ? 'Show less' : `+${b.symbols.length - 12} more`}
                    </button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Source: <span className="font-mono">GET /api/phase3/session-manager/sources</span> — sab real backend counts + symbols. Auto-refresh throttled (30s, hidden tab paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
