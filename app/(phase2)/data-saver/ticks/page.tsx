'use client';

// Live Tick — Data Saver.
//
// Real-time market data for every subscribed instrument. Values come from the
// shared SSE tick stream plus a 10s REST poll (/api/phase2/ticks); nothing here
// is fabricated — a metric the feed has not reported renders as an em dash.
//
// LOOK
// Creamy, theme-aware surfaces on the dashboard's `ds-*` system, floating over a
// slow drifting aurora field.

import { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowUpDown, BarChart3, CircleDot, Clock, Database,
  Pause, Play, Radio, RefreshCw, Search, TableProperties, WifiOff, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLiveStocks, type StockStatus } from '@/hooks/use-live-stocks';
import { StockCard } from '@/components/phase2/stock-card';
import { EmptyState, LoadingState, SectionHeading } from '@/components/design-system';
import { cn } from '@/lib/utils';

type SortKey = 'symbol' | 'ltp' | 'changePct' | 'volume' | 'tickRate' | 'lastTick' | 'token';
type FilterKey = 'all' | StockStatus;

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'symbol', label: 'A-Z' },
  { key: 'ltp', label: 'LTP' },
  { key: 'changePct', label: 'Change %' },
  { key: 'volume', label: 'Volume' },
  { key: 'tickRate', label: 'Tick rate' },
  { key: 'lastTick', label: 'Last tick' },
  { key: 'token', label: 'Token' },
];

const FILTER_OPTIONS: { key: FilterKey; label: string; icon: React.ElementType }[] = [
  { key: 'all', label: 'All', icon: CircleDot },
  { key: 'LIVE', label: 'Live', icon: Activity },
  { key: 'STALE', label: 'Stale', icon: AlertTriangle },
  { key: 'DISCONNECTED', label: 'Disconnected', icon: WifiOff },
  { key: 'ERROR', label: 'Error', icon: AlertTriangle },
  { key: 'WAITING', label: 'Waiting', icon: Clock },
];

function toIstFull(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }) + ' IST';
  } catch { return ''; }
}

/* ========================================================================== */
/* Surfaces                                                                    */
/* ========================================================================== */

function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="ds-drift-a absolute -left-32 -top-32 h-[34rem] w-[34rem] rounded-full bg-primary/10 blur-[110px]" />
      <div className="ds-drift-b absolute -right-40 top-16 h-[36rem] w-[36rem] rounded-full bg-info/10 blur-[120px]" />
      <div className="ds-drift-c absolute -bottom-40 left-1/3 h-[30rem] w-[30rem] rounded-full bg-success/8 blur-[120px]" />
    </div>
  );
}

const ACCENT: Record<string, { rail: string; chip: string; text: string }> = {
  teal: { rail: 'from-teal-400/70 to-emerald-400/40', chip: 'from-teal-400/90 to-emerald-500/80', text: 'text-teal-600 dark:text-teal-400' },
  sky: { rail: 'from-sky-400/70 to-blue-400/40', chip: 'from-sky-400/90 to-blue-500/80', text: 'text-sky-600 dark:text-sky-400' },
  violet: { rail: 'from-violet-400/70 to-purple-400/40', chip: 'from-violet-400/90 to-purple-500/80', text: 'text-violet-600 dark:text-violet-400' },
  amber: { rail: 'from-amber-400/70 to-orange-400/40', chip: 'from-amber-400/90 to-orange-500/80', text: 'text-amber-600 dark:text-amber-400' },
  emerald: { rail: 'from-emerald-400/70 to-teal-400/40', chip: 'from-emerald-400/90 to-teal-500/80', text: 'text-emerald-600 dark:text-emerald-400' },
  rose: { rail: 'from-rose-400/70 to-pink-400/40', chip: 'from-rose-400/90 to-pink-500/80', text: 'text-rose-600 dark:text-rose-400' },
  slate: { rail: 'from-slate-400/60 to-slate-300/30', chip: 'from-slate-400/90 to-slate-500/80', text: 'text-slate-600 dark:text-slate-300' },
};

const TONE_PILL = {
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
  neutral: 'border-border/60 bg-muted/40 text-muted-foreground',
} as const;

function SoftCard({ accent = 'slate', children, className, lift = false, index }: {
  accent?: string; children: React.ReactNode; className?: string; lift?: boolean; index?: number;
}) {
  const a = ACCENT[accent] ?? ACCENT.slate;
  return (
    <div
      style={index != null ? ({ '--ds-i': index } as React.CSSProperties) : undefined}
      className={cn(
        'ds-card relative overflow-hidden rounded-2xl border border-border/50 bg-card/75 shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] backdrop-blur-xl',
        lift && 'ds-lift', index != null && 'ds-rise', className,
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2.5px] bg-gradient-to-r', a.rail)} />
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-24 h-52 w-52 rounded-full bg-primary opacity-[0.04] blur-3xl" />
      {children}
    </div>
  );
}

function PulseDot({ tone, live }: { tone: keyof typeof TONE_PILL; live?: boolean }) {
  const dot = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-destructive', neutral: 'bg-muted-foreground/40' }[tone];
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {live && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-50', dot)} />}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', dot)} />
    </span>
  );
}

/* ========================================================================== */
/* Page                                                                        */
/* ========================================================================== */

export default function Phase2TicksPage() {
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [filterKey, setFilterKey] = useState<FilterKey>('all');

  // One page-level clock drives every card's live tick age — never one interval
  // per card.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const {
    stocks, connected, loading, marketClosed,
    marketSession, schedulerState,
    tickStats, liveCount, staleCount,
    refresh,
  } = useLiveStocks({
    restUrl: '/api/phase2/ticks?limit=200',
    pollMs: paused ? 0 : 10000,
    sse: !paused,
  });

  const subscribedCount = stocks.filter((s) => s.subscribed || s.wsSubscribed).length;

  // Feed composition straight from the live stream (feedLevel is set per stock
  // by /api/phase2/ticks; unknown until the backend reports it).
  const l8Count = stocks.filter((s) => s.feedLevel === 8).length;
  const l4Count = stocks.filter((s) => s.feedLevel === 4).length;
  const depthCount = stocks.filter((s) => s.depth && (s.depth.buy.length > 0 || s.depth.sell.length > 0)).length;

  const filtered = useMemo(() => {
    let list = stocks;
    if (filterKey !== 'all') list = list.filter((s) => s.status === filterKey);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((s) =>
        s.symbol.toLowerCase().includes(q)
        || s.tradingSymbol.toLowerCase().includes(q)
        || s.token.includes(q)
        || s.exchange.toLowerCase().includes(q)
        || (s.companyName ?? '').toLowerCase().includes(q),
      );
    }
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case 'ltp': return (b.ltp ?? -Infinity) - (a.ltp ?? -Infinity);
        case 'changePct': return (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity);
        case 'volume': return (b.volume ?? -Infinity) - (a.volume ?? -Infinity);
        case 'tickRate': return b.ticksPerSec - a.ticksPerSec;
        case 'lastTick': return (b.lastTickAtMs ?? -Infinity) - (a.lastTickAtMs ?? -Infinity);
        case 'token': return a.token.localeCompare(b.token);
        default: return a.symbol.localeCompare(b.symbol);
      }
    });
  }, [stocks, search, sortKey, filterKey]);

  const lastTickIst = tickStats.lastTickAt ? toIstFull(tickStats.lastTickAt) : null;

  // The header must reflect BOTH the backend pipeline AND the browser stream:
  // a running pipeline with a dead SSE is offline.
  const feedLive = tickStats.pipelineState === 'RUNNING' && !marketClosed;
  const headerLive = feedLive && connected && !paused;
  const headerTone: keyof typeof TONE_PILL = marketClosed ? 'neutral'
    : !connected ? 'danger'
      : paused ? 'warning'
        : headerLive ? 'success'
          : tickStats.pipelineState === 'DEGRADED' ? 'warning' : 'neutral';
  const headerLabel = marketClosed ? 'Market closed'
    : !connected ? 'Stream offline'
      : paused ? 'Paused'
        : tickStats.pipelineState === 'RUNNING' ? 'Live'
          : tickStats.pipelineState === 'DEGRADED' ? 'Degraded'
            : tickStats.pipelineState === 'WAITING_FOR_FEED' ? 'Waiting for feed'
              : 'Pipeline stopped';

  const liveClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(now));

  const pipelineNote = tickStats.pipelineState === 'RUNNING' ? 'Pipeline running'
    : tickStats.pipelineState === 'WAITING_FOR_FEED' ? 'Waiting for feed'
      : tickStats.feedState === 'STALE' ? 'Feed stale' : 'Pipeline stopped';

  return (
    <div className="relative min-h-full">
      <Aurora />

      <div className="relative z-10 space-y-4 pb-10">

        {/* ══════════════ HERO ══════════════ */}
        <header className="ds-card relative overflow-hidden rounded-3xl border border-border/50 bg-card/70 p-4 shadow-[0_2px_6px_-2px_hsl(var(--foreground)/0.05),0_24px_60px_-32px_hsl(var(--foreground)/0.25)] backdrop-blur-2xl sm:p-5">
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="ds-drift-a absolute -left-24 -top-28 h-80 w-80 rounded-full bg-primary/12 blur-[90px]" />
            <div className="ds-drift-b absolute -bottom-32 right-0 h-80 w-80 rounded-full bg-info/10 blur-[90px]" />
          </div>

          <div className="relative flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/70 shadow-lg shadow-primary/25">
                  <Activity className="h-5 w-5 text-primary-foreground" />
                  {headerLive && <span className="absolute -inset-0.5 -z-10 rounded-2xl bg-primary/25 ds-breathe" />}
                </span>
                <div>
                  <h1 className="text-xl font-semibold leading-tight tracking-[-0.02em]">Live Tick</h1>
                  <p className="text-[11px] text-muted-foreground">Real-time quotes for every subscribed instrument</p>
                </div>
              </div>

              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold', TONE_PILL[headerTone])}>
                  <PulseDot tone={headerTone} live={headerLive} />
                  {headerLabel}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground backdrop-blur">
                  <Clock className="h-3 w-3" /> {liveClock} IST
                </span>
                {tickStats.feedState && tickStats.feedState !== 'NO_FEED' && (
                  <span className="rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[10px] tabular-nums text-muted-foreground backdrop-blur">
                    Feed {tickStats.feedState}
                  </span>
                )}
                {marketSession && (
                  <span className="rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[10px] tabular-nums text-muted-foreground backdrop-blur">
                    Session {marketSession}
                  </span>
                )}
                {schedulerState && schedulerState !== 'UNKNOWN' && (
                  <span className="rounded-full border border-border/50 bg-background/40 px-2.5 py-1 text-[10px] tabular-nums text-muted-foreground backdrop-blur">
                    Scheduler {schedulerState.replace(/_/g, ' ')}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant={paused ? 'default' : 'ghost'} onClick={() => setPaused((p) => !p)}
                    className="h-8 rounded-full text-[11px]">
                    {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                    {paused ? 'Resume' : 'Pause'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={refresh} aria-label="Refresh"
                    className="rounded-full transition-transform duration-300 hover:scale-105">
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto sm:grid-cols-4 lg:w-[400px]">
              {[
                { label: 'Ticks / sec', value: tickStats.ticksPerSecond > 0 ? tickStats.ticksPerSecond.toFixed(1) : '—', accent: 'teal' },
                { label: 'Received', value: tickStats.totalReceived > 0 ? tickStats.totalReceived.toLocaleString('en-IN') : '—', accent: 'sky' },
                { label: 'Live stocks', value: String(liveCount), accent: 'emerald' },
                { label: 'Feed latency', value: tickStats.feedLatencyMs != null ? `${Math.round(tickStats.feedLatencyMs)}ms` : '—', accent: 'violet' },
              ].map((h, i) => (
                <div key={h.label} style={{ '--ds-i': i } as React.CSSProperties}
                  className="ds-rise ds-lift rounded-2xl border border-border/40 bg-background/50 px-3 py-2.5 backdrop-blur">
                  <p className={cn('text-lg font-semibold leading-none tracking-tight tabular-nums', ACCENT[h.accent].text)}>{h.value}</p>
                  <p className="mt-1.5 truncate text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{h.label}</p>
                </div>
              ))}
            </div>
          </div>
        </header>

        {/* ══════════════ SUMMARY TILES ══════════════ */}
        <section aria-label="Summary" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { icon: Radio, title: 'Subscribed', value: String(subscribedCount), sub: `of ${stocks.length} stocks`, accent: 'slate' },
            { icon: Activity, title: 'Live', value: String(liveCount), sub: liveCount > 0 ? 'feed active' : 'no live feeds', accent: 'emerald' },
            { icon: Zap, title: 'Saved', value: tickStats.totalWritten > 0 ? tickStats.totalWritten.toLocaleString('en-IN') : '—', sub: pipelineNote, accent: 'sky' },
            { icon: Database, title: 'L8 depth', value: stocks.length > 0 ? String(depthCount) : '—', sub: stocks.length > 0 ? `${l8Count} L8 · ${l4Count} L4` : 'no feed to measure', accent: 'violet' },
            { icon: AlertTriangle, title: 'Stale', value: String(staleCount), sub: staleCount > 0 ? `${staleCount} stock${staleCount === 1 ? '' : 's'}` : 'all fresh', accent: 'amber' },
            { icon: WifiOff, title: 'Write errors', value: tickStats.totalWriteErrors > 0 ? tickStats.totalWriteErrors.toLocaleString('en-IN') : '—', sub: tickStats.totalWriteErrors > 0 ? 'persistence failures' : 'no save failures', accent: 'rose' },
          ].map((c, i) => {
            const a = ACCENT[c.accent];
            return (
              <SoftCard key={c.title} accent={c.accent} lift index={i} className="p-3.5">
                <span className={cn('flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md transition-transform duration-300 group-hover:scale-110', a.chip)}>
                  <c.icon className="h-4 w-4" />
                </span>
                <p className="mt-2.5 text-2xl font-semibold leading-none tracking-[-0.03em] tabular-nums">{c.value}</p>
                <p className="mt-1.5 truncate text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">{c.title}</p>
                <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{c.sub}</p>
              </SoftCard>
            );
          })}
        </section>

        {/* ══════════════ FEED STRIP ══════════════ */}
        <SoftCard accent="slate" className="flex flex-wrap items-center gap-x-6 gap-y-1.5 px-4 py-2.5 text-[11px]">
          <Strip icon={Clock} label="Last tick" value={lastTickIst ?? 'No ticks recorded'} />
          <Strip icon={BarChart3} label="Feed latency" value={tickStats.feedLatencyMs != null ? `${Math.round(tickStats.feedLatencyMs)} ms · exchange → backend` : 'Not measured'} />
          <Strip icon={Database} label="Session ticks" value={tickStats.totalReceived > 0 ? `${tickStats.totalReceived.toLocaleString('en-IN')} received · ${tickStats.totalWritten.toLocaleString('en-IN')} saved` : 'No ticks this session'} />
          <Strip icon={Radio} label="Depth" value={depthCount > 0 ? `${depthCount} instrument${depthCount === 1 ? '' : 's'} with 5×5 depth` : 'No depth reported'} />
        </SoftCard>

        {/* ══════════════ CONTROLS ══════════════ */}
        <section aria-label="Controls" className="space-y-2.5">
          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
            <div className="relative min-w-[200px] flex-1 lg:max-w-sm">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search symbol, token, exchange or company…"
                value={search} onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-xl border-border/50 bg-card/60 pl-8 backdrop-blur-xl focus:border-primary/50" />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {FILTER_OPTIONS.map((f) => {
                const count = f.key === 'all' ? stocks.length : stocks.filter((s) => s.status === f.key).length;
                if (f.key !== 'all' && count === 0) return null;
                const on = filterKey === f.key;
                return (
                  <button key={f.key} onClick={() => setFilterKey(f.key)}
                    className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[10px] font-semibold transition-all duration-300',
                      on ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/50 bg-card/60 text-muted-foreground hover:border-border hover:text-foreground')}>
                    <f.icon className="h-3 w-3" />
                    {f.label}
                    <span className="tabular-nums opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground/80">
              <ArrowUpDown className="h-3 w-3" /> Sort
            </span>
            {SORT_OPTIONS.map((s) => (
              <button key={s.key} onClick={() => setSortKey(s.key)}
                className={cn('rounded-full border px-2.5 py-1 text-[10px] font-semibold transition-all duration-300',
                  sortKey === s.key ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border/50 bg-card/60 text-muted-foreground hover:border-border hover:text-foreground')}>
                {s.label}
              </button>
            ))}
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
              {filtered.length === stocks.length
                ? `${stocks.length} stock${stocks.length === 1 ? '' : 's'}`
                : `${filtered.length} of ${stocks.length} stocks`}
            </span>
          </div>
        </section>

        {/* ══════════════ STOCK LIST ══════════════ */}
        {loading && stocks.length === 0 ? (
          <LoadingState text="Loading live ticks…" />
        ) : stocks.length === 0 ? (
          <SoftCard accent="slate" className="p-4">
            <EmptyState
              icon={TableProperties}
              title={marketClosed ? 'Market is closed' : 'No ticks received'}
              description={marketClosed
                ? 'No data has been captured for this session. Ticks will appear when the market is open and the feed is active.'
                : 'Subscribe to stocks from the Stock Subscription page to start receiving live ticks.'}
            />
          </SoftCard>
        ) : filtered.length === 0 ? (
          <SoftCard accent="slate" className="p-4">
            <EmptyState icon={Search} title="No matching stocks"
              description={filterKey !== 'all' ? `No stocks with status "${filterKey}". Try a different filter.`
                : search ? 'No stocks match your search. Try a different term.' : 'No stocks to display.'} />
          </SoftCard>
        ) : (
          <div className="space-y-2">
            <SectionHeading>{filterKey === 'all' ? 'All instruments' : filterKey} · {filtered.length}</SectionHeading>
            {filtered.map((s, i) => (
              <StockCard key={s.symbol} stock={s} connected={connected} marketClosed={marketClosed} now={now} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Strip({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </span>
  );
}