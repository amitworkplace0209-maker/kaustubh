'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Copy,
  Database, Download, History as HistoryIcon, LayoutGrid, MousePointerClick,
  RefreshCw, Search, SlidersHorizontal, Sparkles, TrendingUp, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { useOneShot } from '@/lib/engine-realtime';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { SM, fmtNum, fmtTs } from '@/app/_pages/session-manager/sm-shared';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Session Manager → History — punchy audit console.
 *
 * ONE backend call returns everything (GET /history):
 *   rows[]  — session + instrument ledgers merged server-side, one schema,
 *             newest-first, day = real IST date.
 *   stats{} — served-row genuine counts + real aggregations:
 *             categories (global ledger mix), days (events per IST day),
 *             top_symbols (most-touched, real counts).
 * Advanced: category mix bar · day.navigator pills · top-symbols cloud ·
 * row detail sheet · "/" search shortcut · CSV · live-follow. All values
 * real, missing = '—', fake kabhi nahi.
 */

type Row = {
  ts: string | null;
  day: string;
  event: string;
  category: string;
  ledger: 'session' | 'instrument';
  status: string | null;
  severity: string | null;
  message: string | null;
  instrument: string | null;
  symbol: string | null;
  revision: number | null;
  persisted: boolean;
  meta: Record<string, unknown> | null;
};

type Stats = {
  total: number; errors: number; instruments: number; symbols: number;
  persisted: number; live: number; session_rows: number; instrument_rows: number;
  first_ts: string | null; last_ts: string | null;
  categories: Array<{ category: string; count: number }>;
  days: Array<{ day: string; count: number }>;
  top_symbols: Array<{ symbol: string; count: number }>;
};

/** Vivid per-category kit — badge chip + mix-bar gradient. */
const CAT_KIT: Record<string, { badge: string; grad: string; text: string }> = {
  subscribe: { badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700', grad: 'from-emerald-500 to-teal-500', text: 'text-emerald-700' },
  unsubscribe: { badge: 'border-amber-500/40 bg-amber-500/10 text-amber-700', grad: 'from-amber-500 to-orange-500', text: 'text-amber-700' },
  websocket: { badge: 'border-sky-500/40 bg-sky-500/10 text-sky-700', grad: 'from-sky-500 to-blue-500', text: 'text-sky-700' },
  revision: { badge: 'border-violet-500/40 bg-violet-500/10 text-violet-700', grad: 'from-violet-500 to-purple-500', text: 'text-violet-700' },
  session: { badge: 'border-blue-500/40 bg-blue-500/10 text-blue-700', grad: 'from-blue-500 to-indigo-500', text: 'text-blue-700' },
  instrument: { badge: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700', grad: 'from-cyan-500 to-teal-400', text: 'text-cyan-700' },
  pin: { badge: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700', grad: 'from-fuchsia-500 to-pink-500', text: 'text-fuchsia-700' },
  expire: { badge: 'border-orange-500/40 bg-orange-500/10 text-orange-700', grad: 'from-orange-500 to-rose-500', text: 'text-orange-700' },
  error: { badge: 'border-rose-500/40 bg-rose-500/10 text-rose-700', grad: 'from-rose-500 to-red-500', text: 'text-rose-700' },
  other: { badge: 'border-slate-500/40 bg-slate-500/10 text-slate-700', grad: 'from-slate-500 to-gray-500', text: 'text-slate-700' },
};
const kit = (c: string) => CAT_KIT[c] ?? CAT_KIT.other;

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

const PAGE_SIZE = 50;

export default function SessionManagerHistoryPage() {
  const [limit, setLimit] = useState(200);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('all');
  const [source, setSource] = useState<'all' | 'session' | 'instrument'>('all');
  const [sev, setSev] = useState<'all' | 'err' | 'ok'>('all');
  const [daySel, setDaySel] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [live, setLive] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const path = `${SM}/history?limit=${limit}&category=${encodeURIComponent(cat)}&source=${source}`;
  const hist = useOneShot<{ rows: Row[]; stats?: Stats }>(path);
  const { onFrame } = useFrontendRealtime();

  // "/" focuses search — keyboard flow
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'Escape') setDetail(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // live-follow: optional, throttled 30s, default OFF
  const last = useRef(0);
  const histFn = useRef(hist.refresh);
  histFn.current = hist.refresh;
  useEffect(() => {
    if (!live) return;
    return onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const t = Date.now();
      if (t - last.current < 30000) return;
      last.current = t;
      histFn.current();
    });
  }, [onFrame, live]);

  useEffect(() => { setPage(0); }, [q, sev, limit, cat, source, daySel]);

  const rows = useMemo(() => (hist.data?.rows ?? []) as Row[], [hist.data]);
  const stats = hist.data?.stats;

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (daySel && r.day !== daySel) return false;
      if (sev === 'err' && !(r.category === 'error' || String(r.severity ?? '').toUpperCase() === 'ERROR')) return false;
      if (sev === 'ok' && (r.category === 'error' || String(r.severity ?? '').toUpperCase() === 'ERROR')) return false;
      if (!qq) return true;
      return r.event.toLowerCase().includes(qq)
        || (r.instrument ?? '').toLowerCase().includes(qq)
        || (r.symbol ?? '').toLowerCase().includes(qq)
        || (r.message ?? '').toLowerCase().includes(qq);
    });
  }, [rows, q, sev, daySel]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const withDayBreak = pageRows.map((r, i) => ({ r, brk: i === 0 || pageRows[i - 1].day !== r.day }));

  const loading = !hist.data && !hist.error;
  const error = hist.error;
  const refreshAll = () => hist.refresh();
  const catChips = [{ category: 'all', count: stats?.categories.reduce((s, c) => s + c.count, 0) ?? 0 }, ...(stats?.categories ?? [])];
  const mixTotal = stats?.categories.reduce((s, c) => s + c.count, 0) ?? 0;

  const exportCsv = () => {
    if (!filtered.length) return;
    const head = 'day,time_ist,ledger,category,event,instrument,symbol,revision,message\n';
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = filtered.map((r) => [r.day, r.ts ?? '', r.ledger, r.category, r.event, r.instrument ?? '', r.symbol ?? '', r.revision ?? '', r.message ?? ''].map(esc).join(',')).join('\n');
    const blob = new Blob([head + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-history-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 pb-6">
      {/* HERO — display gradient type + candy accents */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-500" />
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-52 w-52 rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -left-20 -top-20 h-52 w-52 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Link href="/services/session-manager" aria-label="Back to overview" className="rounded-xl border border-border bg-muted/50 p-2 text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-cyan-500 text-white shadow-lg shadow-violet-500/25">
            <HistoryIcon className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate bg-gradient-to-r from-violet-700 via-fuchsia-700 to-cyan-700 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-3xl">History</h1>
            <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground sm:text-sm">
              Unified audit console — dono ledgers ek schema me · <span className="font-mono font-bold text-foreground">{fmtNum(filtered.length)}</span> of {fmtNum(rows.length)} rows displayed
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('gap-1 tabular-nums font-semibold', (stats?.errors ?? 0) > 0 ? 'border-rose-500/40 bg-rose-500/10 text-rose-700' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700')}>
              {fmtNum(stats?.errors ?? 0)} errors
            </Badge>
            {stats?.first_ts && <Badge variant="outline" className="tabular-nums text-muted-foreground" title={`span: ${fmtTs(stats.first_ts)} → ${fmtTs(stats.last_ts)}`}>{stats.first_ts?.slice(0, 10)} → {stats.last_ts?.slice(0, 10)}</Badge>}
            <button onClick={() => setLive((v) => !v)} title="Live-follow (30s throttle)" className={cn('rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors', live ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-800' : 'border-border text-muted-foreground')}>
              {live ? '● LIVE' : '○ LIVE OFF'}
            </button>
            <IstClock />
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!filtered.length} className="gap-1.5"><Download className="h-3.5 w-3.5" /> CSV</Button>
            <Button size="sm" onClick={refreshAll} className="gap-1.5 bg-gradient-to-r from-violet-600 to-cyan-600 shadow-md"><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          <span className="min-w-0">History load failed: {error} — retry karo, fake rows nahi dikhayenge.</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={refreshAll}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP — candy cards, gradient chips */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(([
          { icon: LayoutGrid, label: 'Rows served', value: fmtNum(stats?.total ?? 0), sub: `${fmtNum(stats?.session_rows ?? 0)} session · ${fmtNum(stats?.instrument_rows ?? 0)} instrument`, grad: 'from-violet-500 to-purple-600', tint: 'bg-violet-500/[0.09]' },
          { icon: Sparkles, label: 'Errors', value: fmtNum(stats?.errors ?? 0), sub: (stats?.errors ?? 0) > 0 ? 'filter se dekh sakte ho' : 'clean ledger', grad: (stats?.errors ?? 0) > 0 ? 'from-rose-500 to-red-600' : 'from-emerald-500 to-teal-600', tint: (stats?.errors ?? 0) > 0 ? 'bg-rose-500/[0.09]' : 'bg-emerald-500/[0.09]' },
          { icon: Database, label: 'DB persisted', value: fmtNum(stats?.persisted ?? 0), sub: `+${fmtNum(stats?.live ?? 0)} live ring`, grad: 'from-cyan-500 to-sky-600', tint: 'bg-cyan-500/[0.09]' },
          { icon: TrendingUp, label: 'Active instruments', value: fmtNum(stats?.instruments ?? 0), sub: `${fmtNum(stats?.symbols ?? 0)} symbols`, grad: 'from-fuchsia-500 to-pink-600', tint: 'bg-fuchsia-500/[0.09]' },
        ]) as Array<{ icon: React.ElementType; label: string; value: string; sub?: string; grad: string; tint: string }> ).map((k) => (
          <Card key={k.label} className={cn('relative overflow-hidden border shadow-soft ring-1 ring-inset ring-black/[0.02] bg-gradient-to-br from-card via-card transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg', k.tint)}>
            <CardContent className="flex items-center gap-3 p-3.5">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-lg', k.grad)}>
                <k.icon className="h-5 w-5 text-white" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{k.label}</p>
                {loading ? <div className="mt-1 h-6 w-20 animate-pulse rounded bg-muted/70" /> : <p className="truncate font-mono text-xl font-extrabold tabular-nums leading-7">{k.value}</p>}
                <p className="truncate text-[11px] text-muted-foreground">{k.sub ?? ' '}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* CATEGORY MIX — stacked spectrum + day pills + top symbols (saare real聚合) */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {/* mix bar */}
        <Card className="overflow-hidden border shadow-soft xl:col-span-2">
          <CardContent className="p-3.5">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-violet-700" />
              <p className="text-xs font-bold">Category spectrum</p>
              <span className="font-mono text-[10px] text-muted-foreground">global ledger mix · pre-filter</span>
            </div>
            {loading ? (
              <div className="h-4 w-full animate-pulse rounded bg-muted/70" />
            ) : mixTotal === 0 ? (
              <p className="text-xs text-muted-foreground">Ledger khali — koi category nahi.</p>
            ) : (
              <>
                <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted/60">
                  {stats?.categories.map((c) => (
                    <span key={c.category} className={cn('h-full transition-all bg-gradient-to-r', kit(c.category).grad)} style={{ width: `${(c.count / mixTotal) * 100}%` }} title={`${c.category}: ${c.count}`} />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {stats?.categories.map((c) => (
                    <button key={c.category} onClick={() => setCat(c.category)} className={cn('rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-all hover:scale-105', kit(c.category).badge, cat === c.category && 'ring-2 ring-offset-1 ring-primary/40')}>
                      {c.category}<span className="ml-1 font-mono opacity-80">{fmtNum(c.count)}</span>
                    </button>
                  ))}
                  {cat !== 'all' && <button onClick={() => setCat('all')} className="ml-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-bold text-muted-foreground hover:text-foreground">reset ✕</button>}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* top symbols */}
        <Card className="overflow-hidden border shadow-soft">
          <CardContent className="p-3.5">
            <div className="mb-2 flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-cyan-700" />
              <p className="text-xs font-bold">Top symbols</p>
              <span className="font-mono text-[10px] text-muted-foreground">loaded rows me</span>
            </div>
            {loading ? <div className="h-16 animate-pulse rounded bg-muted/60" /> : !(stats?.top_symbols?.length) ? (
              <p className="text-xs text-muted-foreground">—instrument rows nahi hain (session ledger pe).</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {stats.top_symbols.map((s, i) => (
                  <button key={s.symbol} onClick={() => { setQ(s.symbol); setCat('all'); }} className={cn('group flex items-center gap-1.5 rounded-lg bg-gradient-to-br px-2 py-1 text-[10px] font-bold text-white shadow transition-all hover:scale-105', ['from-violet-500 to-fuchsia-600', 'from-cyan-500 to-sky-600', 'from-emerald-500 to-teal-600', 'from-amber-500 to-orange-600', 'from-rose-500 to-pink-600'][i % 5])} title={`${s.symbol} · ${s.count} events — click = search`}>
                    {s.symbol}<span className="font-mono opacity-90">{fmtNum(s.count)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* DAY NAVIGATOR — events per IST day */}
      <Card className="overflow-hidden border shadow-soft">
        <CardContent className="p-3.5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <CalendarDays className="h-3.5 w-3.5 text-blue-700" />
            <p className="text-xs font-bold">Day navigator</p>
            <span className="font-mono text-[10px] text-muted-foreground">IST days in loaded rows · click = filter</span>
            {daySel && (
              <button onClick={() => setDaySel(null)} className="ml-auto rounded-full border border-primary/40 bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold text-foreground">
                {daySel} ✕ clear
              </button>
            )}
          </div>
          {loading ? (
            <div className="h-9 w-full animate-pulse rounded bg-muted/60" />
          ) : !(stats?.days?.length) ? (
            <p className="text-xs text-muted-foreground">No dated rows loaded — limit badhao ya refresh karo.</p>
          ) : (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {stats.days.map((d, i) => (
                <button key={d.day} onClick={() => setDaySel((v) => (v === d.day ? null : d.day))} className={cn('flex min-w-[76px] shrink-0 flex-col items-center rounded-xl border px-2.5 py-1.5 transition-all hover:-translate-y-0.5 hover:shadow-soft', daySel === d.day ? 'border-primary/60 bg-primary/10 ring-2 ring-primary/30' : 'border-border hover:border-primary/30')}>
                  <span className={cn('font-mono text-[11px] font-extrabold', ['text-violet-700', 'text-cyan-700', 'text-emerald-700', 'text-amber-700', 'text-fuchsia-700', 'text-sky-700', 'text-rose-700'][i % 7])}>{d.day.slice(5)}</span>
                  <span className="font-mono text-[9px] font-bold tabular-nums text-muted-foreground">{fmtNum(d.count)} ev</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* FILTERS */}
      <Card className="shadow-soft">
        <CardContent className="space-y-2.5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 sm:max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search event / instrument / symbol / message…  ( / se focus )" className="h-9 pl-8 pr-8 text-xs" />
              {q && <button onClick={() => setQ('')} aria-label="Clear" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
              {(['all', 'session', 'instrument'] as const).map((l) => (
                <button key={l} onClick={() => setSource(l)} className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors', source === l ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}>{l === 'all' ? 'Both ledgers' : l}</button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
              {(['all', 'err', 'ok'] as const).map((s) => (
                <button key={s} onClick={() => setSev(s)} className={cn('rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors', sev === s ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground')}>{s === 'all' ? 'All' : s === 'err' ? 'Errors' : 'Non-error'}</button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {([100, 200, 500] as const).map((n) => (
                <button key={n} onClick={() => setLimit(n)} className={cn('rounded-lg border px-2 py-1.5 font-mono text-[11px] tabular-nums transition-colors', limit === n ? 'border-primary/40 bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground')}>{n}</button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            {(loading ? [{ category: 'all', count: 0 }] : catChips).map((c) => (
              <button key={c.category} onClick={() => setCat(c.category)} className={cn('rounded-full border px-2.5 py-1 text-[11px] font-bold capitalize transition-colors', cat === c.category ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}>
                {c.category}<span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{fmtNum(c.count)}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* TABLE — colorful badges + gradient day breakers + click = sheet */}
      <Card className="overflow-hidden shadow-soft">
        <div className="flex flex-row items-center gap-2 border-b border-border/50 bg-muted/40 px-3 py-2.5">
          <MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-bold">Audit trail</p>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{safePage + 1} / {totalPages}</span>
            <Button size="sm" variant="ghost" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
          </span>
        </div>
        <CardContent className="p-0">
          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground backdrop-blur">
                <tr>
                  <th className="px-3 py-2">Time (IST)</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Instrument</th>
                  <th className="px-3 py-2">Rev</th><th className="px-3 py-2">Message</th><th className="px-2 py-2">Src</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [0, 1, 2, 3, 4, 5].map((i) => <tr key={i} className="border-b border-border/40"><td colSpan={6} className="px-3 py-2"><div className="h-7 animate-pulse rounded bg-muted/60" /></td></tr>)
                ) : withDayBreak.map(({ r, brk }) => {
                  const K = kit(r.category);
                  return (
                    <Fragment key={`${r.ts}-${r.event}-${r.message ?? ''}`}>
                      {brk && <tr><td colSpan={6} className="border-y bg-gradient-to-r from-violet-500/[0.08] to-cyan-500/[0.06] px-3 py-1 font-mono text-[10px] font-extrabold uppercase tracking-wider text-violet-800">{r.day}</td></tr>}
                      <tr onClick={() => setDetail(r)} className="cursor-pointer border-b border-border/40 transition-colors hover:bg-black/[0.03]">
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums">{fmtTs(r.ts)}</td>
                        <td className="px-3 py-1.5">
                          <span className="flex items-center gap-1.5">
                            <Badge variant="outline" className={cn('max-w-[220px] truncate font-mono text-[10px] font-bold', K.badge)} title={r.event}>{r.event.toUpperCase().slice(0, 26)}</Badge>
                          </span>
                        </td>
                        <td className="max-w-[190px] px-3 py-1.5">
                          {r.instrument ? (
                            <span className="flex items-center gap-1.5">
                              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-br', K.grad)} />
                              <span className="block truncate font-mono font-semibold" title={r.symbol ? `${r.instrument} · ${r.symbol}` : r.instrument}>{r.symbol ?? r.instrument}</span>
                            </span>
                          ) : '—'}
                        </td>
                        <td className="px-3 py-1.5 font-mono tabular-nums">{r.revision != null ? <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 font-mono text-[9px] font-bold text-violet-700">r{fmtNum(r.revision)}</Badge> : '—'}</td>
                        <td className="max-w-[300px] truncate px-3 py-1.5 text-muted-foreground" title={r.message ?? undefined}>{r.message ?? '—'}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          <Badge variant="outline" className={cn('text-[9px] font-bold', r.ledger === 'instrument' ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-700' : 'border-violet-500/40 bg-violet-500/10 text-violet-700')}>{r.ledger}</Badge>
                          <Badge variant="outline" className={cn('ml-1 text-[9px] font-bold', r.persisted ? 'border-emerald-500/40 text-emerald-700' : 'border-border text-muted-foreground')}>{r.persisted ? 'DB' : 'live'}</Badge>
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
                {!loading && !filtered.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No history rows match — filter badlo ya limit badhao.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ROW DETAIL SHEET */}
      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setDetail(null)}>
          <div aria-hidden className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" />
          <aside className="relative flex h-full w-full max-w-md flex-col border-l bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-2 border-b bg-gradient-to-r from-violet-500/10 to-cyan-500/10 p-3.5">
              <span className={cn('mt-0.5 h-2 w-2 rounded-full bg-gradient-to-br', kit(detail.category).grad)} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-extrabold" title={detail.event}>{detail.event}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{fmtTs(detail.ts)} · {detail.day} · {detail.category} · {detail.ledger}{detail.persisted ? ' · DB' : ' · live'}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setDetail(null)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-3.5 text-xs">
              {([
                ['Message', detail.message ?? '—'],
                ['Status', detail.status ?? '—'],
                ['Severity', detail.severity ?? '—'],
                ['Instrument', detail.instrument ?? '—'],
                ['Symbol', detail.symbol ?? '—'],
                ['Revision', detail.revision != null ? `r${fmtNum(detail.revision)}` : '—'],
                ['Persisted', detail.persisted ? 'yes (DB ledger)' : 'no (in-memory ring)'],
              ] as const).map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-black/[0.02] px-2.5 py-1.5">
                  <span className="shrink-0 font-bold text-muted-foreground">{k}</span>
                  <span className="min-w-0 break-all text-right font-mono" title={String(v)}>{v}</span>
                </div>
              ))}
              {detail.meta && Object.keys(detail.meta).length > 0 && (
                <div className="rounded-lg border border-border/60 bg-black/[0.02] p-2.5">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">meta (row ka real payload)</p>
                  <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{JSON.stringify(detail.meta, null, 2)}</pre>
                </div>
              )}
            </div>
            <div className="border-t p-3">
              <Button size="sm" variant="outline" className="w-full gap-1.5"
                onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(detail)); }}>
                <Copy className="h-3.5 w-3.5" /> Copy row JSON
              </Button>
            </div>
          </aside>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Source: <span className="font-mono">GET /history</span> — session (<span className="font-mono">system_events</span> + live ring) aur instrument (<span className="font-mono">sm_events</span>) ledgers backend me merge; spectrum/days/top-symbols real aggregations hain (loaded rows me). Tip: <span className="font-mono">/</span> se search focus, row click = detail sheet, ESC = close. Missing = '—', fake kabhi nahi.
      </p>
    </div>
  );
}
