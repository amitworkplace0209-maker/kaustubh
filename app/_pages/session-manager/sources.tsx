'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, ArrowUpRight, Database, Filter, Layers, RefreshCw, Radio, Search, Trophy, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, fmtNum, fmtTs } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → Sources — real origin rollup + Market Watch engine facts.
 *
 * Real data only:
 *  GET /api/phase3/session-manager/sources
 *    · sources{}      — every origin TAG a row carries (a row can sit in >1 bucket)
 *    · primary{}      — every row counted EXACTLY ONCE by its primary origin (shares sum to 100%)
 *    · marketWatch{}  — the Market Watch engine's own live registry facts (universe, eligibility,
 *                       subscription, feed state, status counts) — verbatim backend engine values.
 * Missing = '—'/skeleton, never fake. Throttled WS#2 cadence (30s, hidden tab paused).
 */

const SM_SOURCES = `${SM}/sources`;

type Bucket = {
  count: number;
  desired: number;
  subscribed: number;
  pinned: number;
  expired: number;
  indexes: number;
  symbols: string[];
  last_update_at: string | null;
};

type MwFacts = {
  universeSize: number;
  eligibleCount: number;
  subscribedTokenCount: number;
  feedState: string;
  statusCounts: Record<string, number>;
};

type SourcesPayload = {
  sources?: Record<string, Bucket>;
  primary?: Record<string, Bucket>;
  marketWatchPrimaryCount?: number;
  total?: number;
  marketWatch?: MwFacts | null;
};

const PALETTE = [
  { bar: '#10b981', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600', tint: 'to-emerald-500/[0.09]', ring: 'hover:border-emerald-500/60' },
  { bar: '#06b6d4', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600', tint: 'to-cyan-500/[0.09]', ring: 'hover:border-cyan-500/60' },
  { bar: '#8b5cf6', chip: 'bg-gradient-to-br from-violet-500 to-purple-600', tint: 'to-violet-500/[0.09]', ring: 'hover:border-violet-500/60' },
  { bar: '#f59e0b', chip: 'bg-gradient-to-br from-amber-500 to-orange-600', tint: 'to-amber-500/[0.10]', ring: 'hover:border-amber-500/60' },
  { bar: '#f43f5e', chip: 'bg-gradient-to-br from-rose-500 to-red-600', tint: 'to-rose-500/[0.09]', ring: 'hover:border-rose-500/60' },
  { bar: '#0ea5e9', chip: 'bg-gradient-to-br from-sky-500 to-blue-600', tint: 'to-sky-500/[0.09]', ring: 'hover:border-sky-500/60' },
  { bar: '#d946ef', chip: 'bg-gradient-to-br from-fuchsia-500 to-pink-600', tint: 'to-fuchsia-500/[0.09]', ring: 'hover:border-fuchsia-500/60' },
  { bar: '#14b8a6', chip: 'bg-gradient-to-br from-teal-500 to-cyan-600', tint: 'to-teal-500/[0.09]', ring: 'hover:border-teal-500/60' },
];

/** Market Watch engine per-stock status colors (doc-stated status set). */
const MW_STATUS_COLORS: Record<string, string> = {
  LIVE: '#10b981',
  PENDING: '#94a3b8',
  STALE: '#f59e0b',
  NO_DATA: '#fb7185',
  INACTIVE: '#64748b',
  PRICE_CAPPED: '#d946ef',
};

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

function Kpi({ icon: Icon, label, value, sub, tint, chip, loading }: {
  icon: React.ElementType; label: string; value: string; sub?: string; tint: string; chip: string; loading?: boolean;
}) {
  return (
    <Card className={cn('relative overflow-hidden border shadow-soft ring-1 ring-inset ring-black/[0.02] bg-gradient-to-br from-card via-card transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg', tint)}>
      <CardContent className="flex items-center gap-3 p-3.5">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-lg', chip)}>
          <Icon className="h-5 w-5 text-white" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
          {loading ? <div className="mt-1 h-6 w-20 animate-pulse rounded bg-muted/70" /> : <p className="truncate font-mono text-lg font-bold tabular-nums leading-7" title={String(value)}>{value}</p>}
          <p className="truncate text-[11px] text-muted-foreground">{sub ?? ' '}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SessionManagerSourcesPage() {
  const { data, error, refresh } = useOneShot<SourcesPayload>(SM_SOURCES);
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
      .map(([name, b]: [string, any]) => ({
        name,
        count: Number(b?.count ?? 0),
        desired: Number(b?.desired ?? 0),
        subscribed: Number(b?.subscribed ?? 0),
        pinned: Number(b?.pinned ?? 0),
        expired: Number(b?.expired ?? 0),
        indexes: Number(b?.indexes ?? 0),
        symbols: (b?.symbols ?? []) as string[],
        lastUpdate: (b?.last_update_at ?? null) as string | null,
      }))
      .sort((a, b) => b.count - a.count);
  }, [data?.sources]);

  const primary = useMemo(() => {
    const p = data?.primary ?? {};
    const out: Record<string, number> = {};
    Object.entries(p).forEach(([k, v]: any) => { out[k] = Number(v?.count ?? 0); });
    return out;
  }, [data?.primary]);

  const total = Number(data?.total ?? 0);
  const primaryTotal = Object.values(primary).reduce((s, c) => s + c, 0) || total;
  const mw = data?.marketWatch ?? null;
  const top = buckets[0] ?? null;
  const loading = !data && !error;

  const qq = q.trim().toLowerCase();
  const filtered = qq
    ? buckets.filter((b) => b.name.toLowerCase().includes(qq) || b.symbols.some((s) => s.toLowerCase().includes(qq)))
    : buckets;

  const mwStatus = useMemo(() => Object.entries(mw?.statusCounts ?? {}).sort((a, b) => b[1] - a[1]), [mw?.statusCounts]);

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
              Instrument origins · <span className="font-mono font-semibold text-foreground">{fmtNum(total)}</span> rows · primary shares 100% · Market Watch engine facts inline
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-violet-500/30 bg-violet-500/10 tabular-nums text-violet-700">{fmtNum(buckets.length)} origins</Badge>
            {mw && (
              <Badge variant="outline" className={cn('tabular-nums', mw.feedState === 'CONNECTED' || mw.feedState === 'LIVE' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/40 bg-amber-500/10 text-amber-700')}>
                MW feed {String(mw.feedState ?? '—')}
              </Badge>
            )}
            <IstClock />
            <Button size="sm" onClick={() => refresh()} className="gap-1.5 bg-gradient-to-r from-violet-500 to-cyan-500 shadow-md">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        </div>
        <div className="relative flex h-2 w-full overflow-hidden bg-muted/60">
          {primaryTotal > 0 && buckets.map((b, i) => {
            const share = (primary[b.name] ?? 0) / primaryTotal * 100;
            if (!share) return null;
            return <span key={b.name} className="h-full transition-all" style={{ width: `${share}%`, background: PALETTE[i % PALETTE.length].bar }} />;
          })}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">Sources load failed: {error} — retry karo, fake data nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => refresh()}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={Database} label="Total instruments" value={fmtNum(total)} sub="canonical registry rows" tint="to-violet-500/[0.09]" chip="bg-gradient-to-br from-violet-500 to-purple-600" loading={loading} />
        <Kpi icon={Layers} label="Distinct origins" value={fmtNum(buckets.length)} sub="rows may carry multiple tags" tint="to-cyan-500/[0.09]" chip="bg-gradient-to-br from-cyan-500 to-sky-600" loading={loading} />
        <Kpi icon={Trophy} label="Top primary source" value={top ? `${top.name} · ${fmtNum(primary[top.name] ?? top.count)}` : '—'} sub={top && primaryTotal ? `${(((primary[top.name] ?? 0) / primaryTotal) * 100).toFixed(1)}% of registry (counted once)` : undefined} tint="to-amber-500/[0.10]" chip="bg-gradient-to-br from-amber-500 to-orange-600" loading={loading} />
        <Kpi icon={Zap} label="Market Watch universe" value={mw ? fmtNum(mw.universeSize) : '—'} sub={mw ? `${fmtNum(mw.eligibleCount)} eligible · ${fmtNum(mw.subscribedTokenCount)} subscribed` : 'engine facts unavailable'} tint="to-emerald-500/[0.09]" chip="bg-gradient-to-br from-emerald-500 to-teal-600" loading={loading} />
      </div>

      {/* MARKET WATCH ENGINE — verbatim engine facts */}
      <Card className="overflow-hidden border-emerald-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-emerald-500/12 via-cyan-500/8 to-sky-500/10 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 p-1.5 text-white shadow"><Radio className="h-3.5 w-3.5" /></span>
            Market Watch engine · live registry facts
            {mw && (
              <Badge variant="outline" className={cn('ml-auto tabular-nums', mw.feedState === 'CONNECTED' || mw.feedState === 'LIVE' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700' : 'border-amber-500/40 bg-amber-500/10 text-amber-700')}>
                feed {String(mw.feedState ?? '—')}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-3">
          {loading ? (
            <div className="grid grid-cols-2 gap-2 min-[720px]:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/60" />)}</div>
          ) : !mw ? (
            <p className="py-3 text-center text-xs text-muted-foreground">Engine facts unavailable unhi ke facts bina — koi guessed proxy nahi.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 min-[720px]:grid-cols-4">
                <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-b from-emerald-500/[0.12] to-transparent px-3 py-2">
                  <p className="font-mono text-lg font-bold tabular-nums text-emerald-700">{fmtNum(mw.universeSize)}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Universe · today</p>
                </div>
                <div className="rounded-xl border border-cyan-500/30 bg-gradient-to-b from-cyan-500/[0.12] to-transparent px-3 py-2">
                  <p className="font-mono text-lg font-bold tabular-nums text-cyan-700">{fmtNum(mw.eligibleCount)}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Intraday eligible</p>
                </div>
                <div className="rounded-xl border border-violet-500/30 bg-gradient-to-b from-violet-500/[0.12] to-transparent px-3 py-2">
                  <p className="font-mono text-lg font-bold tabular-nums text-violet-700">{fmtNum(mw.subscribedTokenCount)}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Subscribed tokens</p>
                </div>
                <div className="rounded-xl border border-amber-500/30 bg-gradient-to-b from-amber-500/[0.12] to-transparent px-3 py-2">
                  <p className="font-mono text-lg font-bold tabular-nums text-amber-700">{fmtNum(data?.marketWatchPrimaryCount ?? 0)}</p>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Registry rows tagged MW</p>
                </div>
              </div>
              {mwStatus.length > 0 && (
                <div className="mt-3 border-t border-border/50 pt-2.5">
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Engine stock status mix</p>
                  <div className="space-y-1.5">
                    {mwStatus.map(([k, v]) => {
                      const denom = mwStatus.reduce((s, [, n]) => s + n, 0) || 1;
                      const pct = (v / denom) * 100;
                      const color = MW_STATUS_COLORS[k] ?? '#38bdf8';
                      return (
                        <div key={k} className="flex items-center gap-2 text-[11px]">
                          <span className="w-28 shrink-0 truncate font-mono font-semibold">{k}</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/70">
                            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
                          </div>
                          <span className="w-12 shrink-0 text-right font-mono tabular-nums">{fmtNum(v)}</span>
                          <span className="w-11 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* DISTRIBUTION — primary origins (sum = 100%) */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-cyan-500/10 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-cyan-600 p-1.5 text-white shadow"><Layers className="h-3.5 w-3.5" /></span>
            Distribution · primary origin (har instrument 1 baar)
            <Badge variant="outline" className="ml-auto tabular-nums">{fmtNum(primaryTotal)} rows · 100%</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 pt-3">
          {loading ? (
            <div className="space-y-1.5">{[0, 1, 2].map((i) => <div key={i} className="h-7 animate-pulse rounded-lg bg-muted/60" />)}</div>
          ) : !buckets.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No instruments yet — no source data.</p>
          ) : (
            buckets.map((b, i) => {
              const rows = primary[b.name] ?? 0;
              const pct = primaryTotal ? (rows / primaryTotal) * 100 : 0;
              return (
                <div key={b.name} className="flex items-center gap-2 text-[11px]">
                  <span className="w-40 shrink-0 truncate font-mono font-semibold" title={b.name}>{b.name}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted/70">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${PALETTE[i % PALETTE.length].bar}, ${PALETTE[i % PALETTE.length].bar}aa)` }} />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono tabular-nums">{fmtNum(rows)}</span>
                  <span className="w-12 shrink-0 text-right font-mono tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* FILTER + SOURCE CARDS */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by origin / symbol…" className="pl-9" />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-muted/60" />)}
        </div>
      ) : !filtered.length ? (
        <p className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          {buckets.length ? `No match for "${q}".` : 'No instruments yet — no source data.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((b) => {
            const idx = buckets.findIndex((x) => x.name === b.name);
            const c = PALETTE[idx % PALETTE.length];
            const open = expanded === b.name;
            const shown = open ? b.symbols : b.symbols.slice(0, 12);
            const primaryCount = primary[b.name] ?? 0;
            const primaryPct = primaryTotal ? (primaryCount / primaryTotal) * 100 : 0;
            const isMw = b.name.includes('market_watch');
            const freshCode = b.lastUpdate ? fmtTs(b.lastUpdate) : '—';
            return (
              <Card key={b.name} className={cn('group overflow-hidden border shadow-soft ring-1 ring-inset ring-black/[0.02] bg-gradient-to-br from-card via-card transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg', c.tint, c.ring)}>
                <CardHeader className="pb-1">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <span className={cn('rounded-lg p-1.5 shadow-lg', c.chip)}><Filter className="h-3.5 w-3.5 text-white" /></span>
                    <span className="min-w-0 flex-1 truncate" title={b.name}>{b.name}</span>
                    {isMw && <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[9px] font-semibold text-emerald-700">MW engine</Badge>}
                    <span className="font-mono text-lg font-bold tabular-nums">{fmtNum(b.count)}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted/70">
                    <div className="h-full rounded-full transition-all" style={{ width: `${primaryPct}%`, background: c.bar }} />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="font-mono">primary {fmtNum(primaryCount)} ({primaryPct.toFixed(1)}%)</span>
                    <span className="flex items-center gap-1 font-mono" title="latest registry touch from this source (IST)">
                      <ArrowUpRight className="h-3 w-3" /> {freshCode}
                    </span>
                  </div>
                  {/* real lifecycle stats per origin */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/[0.12] text-[9px] font-semibold text-emerald-800">desired {fmtNum(b.desired)}</Badge>
                    <Badge variant="outline" className={cn(b.subscribed ? 'border-sky-500/40 bg-sky-500/[0.12] text-[9px] font-semibold text-sky-800' : 'border-border text-[9px] text-muted-foreground')}>subscribed {fmtNum(b.subscribed)}</Badge>
                    <Badge variant="outline" className={cn(b.pinned ? 'border-amber-500/40 bg-amber-500/[0.12] text-[9px] font-semibold text-amber-800' : 'border-border text-[9px] text-muted-foreground')}>pinned {fmtNum(b.pinned)}</Badge>
                    <Badge variant="outline" className={cn(b.expired ? 'border-rose-500/40 bg-rose-500/[0.12] text-[9px] font-semibold text-rose-800' : 'border-border text-[9px] text-muted-foreground')}>expired {fmtNum(b.expired)}</Badge>
                    {b.indexes > 0 && <Badge variant="outline" className="border-violet-500/40 bg-violet-500/[0.12] text-[9px] font-semibold text-violet-800">IDX {fmtNum(b.indexes)}</Badge>}
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
        Source: <span className="font-mono">GET /api/phase3/session-manager/sources</span> — <span className="font-mono">sources</span> = origin TAGS (ek row multiple me ho sakti hai) · <span className="font-mono">primary</span> = har row ek hi baar (100%) · <span className="font-mono">marketWatch</span> = engine ke verbatim registry facts. Auto-refresh throttled (30s, hidden tab paused). Missing = ‘—’, fake kabhi nahi.
      </p>
    </div>
  );
}
