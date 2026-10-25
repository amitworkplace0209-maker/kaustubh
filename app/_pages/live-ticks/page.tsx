'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Activity, Pause, Play, Search, Wifi, WifiOff, ChevronDown, ChevronRight,
  Clock, TrendingUp, ArrowUpDown, ArrowUp, ArrowDown, X, Settings2, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getRecentTicks } from '@/lib/api';
import { subscribeSseState, subscribeTicks } from '@/lib/shared-sse';

// ─── Types ───────────────────────────────────────────────────────────

interface RawTick {
  symbol: string;
  tradingSymbol?: string;
  instrumentToken: string;
  exchangeSegment?: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  ltq?: number | null;
  tbq?: number | null;
  tsq?: number | null;
  bp?: number | null;
  sp?: number | null;
  bq?: number | null;
  bs?: number | null;
  averagePrice?: number | null;
  change: number | null;
  changePercent: number | null;
  oi?: number | null;
  ts: string;
  receivedAt?: string;
}

interface TickHistory {
  ticks: number[];
  emaValues: Record<number, number | null>;
}

type SortKey = 'symbol' | 'ltp' | 'wap' | 'volume' | 'change' | 'changePercent' | 'ts';
type SortDir = 'asc' | 'desc';

// ─── EMA Calculation ─────────────────────────────────────────────────

const DEFAULT_EMA_PERIODS = [9, 15, 20, 50, 100, 200];

function calcEma(prices: number[], period: number): number | null {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let ema = 0;
  for (let i = 0; i < period; i++) ema += prices[i];
  ema /= period;
  // Apply EMA
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeEmas(history: number[], periods: number[]): Record<number, number | null> {
  const result: Record<number, number | null> = {};
  for (const p of periods) {
    result[p] = calcEma(history, p);
  }
  return result;
}

// ─── Formatting Helpers ──────────────────────────────────────────────

function formatInr(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCompact(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  return n.toLocaleString('en-IN');
}

function formatChange(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatChangePct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2) + '%';
}

function toIst(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('en-IN', {
      hour12: false,
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch { return '—'; }
}

function toIstFull(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch { return '—'; }
}

function isStale(ts: string | null | undefined, thresholdMs = 15000): boolean {
  if (!ts) return true;
  try {
    const d = new Date(ts);
    return Date.now() - d.getTime() > thresholdMs;
  } catch { return true; }
}

// ─── Enriched Tick ───────────────────────────────────────────────────

interface EnrichedTick {
  symbol: string;
  tradingSymbol?: string;
  instrumentToken: string;
  exchangeSegment?: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  ltq?: number | null;
  tbq?: number | null;
  tsq?: number | null;
  bp?: number | null;
  sp?: number | null;
  bq?: number | null;
  bs?: number | null;
  averagePrice: number | null;
  change: number | null;
  changePercent: number | null;
  oi?: number | null;
  ts: string;
  receivedAt?: string;
  ema: Record<number, number | null>;
  prevLtp: number | null;
}

// ─── Price Flash Cell ────────────────────────────────────────────────

function FlashCell({
  value,
  prevValue,
  className,
  children,
}: {
  value: number | null;
  prevValue: number | null;
  className?: string;
  children: React.ReactNode;
}) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  useEffect(() => {
    if (value == null || prevValue == null || value === prevValue) {
      setFlash(null);
      return;
    }
    setFlash(value > prevValue ? 'up' : 'down');
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [value, prevValue]);

  return (
    <td className={cn(
      'text-right font-mono transition-colors duration-300',
      flash === 'up' && 'bg-success/10',
      flash === 'down' && 'bg-destructive/10',
      className,
    )}>
      {children}
    </td>
  );
}

// ─── Expanded Row Details ────────────────────────────────────────────

function ExpandedDetails({ tick, emaPeriods }: { tick: EnrichedTick; emaPeriods: number[] }) {
  return (
    <tr className="bg-muted/20">
      <td colSpan={99} className="p-0">
        <div className="px-4 py-4 animate-in slide-in-from-top-1 duration-200">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <DetailItem label="Symbol" value={tick.symbol} />
            <DetailItem label="Exchange" value={tick.exchangeSegment || '—'} />
            <DetailItem label="Token" value={tick.instrumentToken} />
            <DetailItem label="LTP" value={formatInr(tick.ltp)} accent />
            <DetailItem label="WAP" value={formatInr(tick.averagePrice)} />
            <DetailItem label="Open" value={formatInr(tick.open)} />
            <DetailItem label="High" value={formatInr(tick.high)} color="text-success" />
            <DetailItem label="Low" value={formatInr(tick.low)} color="text-destructive" />
            <DetailItem label="Prev Close" value={formatInr(tick.close)} />
            <DetailItem label="Volume" value={tick.volume != null ? tick.volume.toLocaleString('en-IN') : '—'} />
            <DetailItem label="Change" value={formatChange(tick.change)} color={(tick.change ?? 0) >= 0 ? 'text-success' : 'text-destructive'} />
            <DetailItem label="Change %" value={formatChangePct(tick.changePercent)} color={(tick.changePercent ?? 0) >= 0 ? 'text-success' : 'text-destructive'} />
            <DetailItem label="LTQ" value={tick.ltq?.toLocaleString('en-IN') || '—'} />
            <DetailItem label="Bid" value={tick.bp != null ? `${formatInr(tick.bp)} × ${tick.bq ?? '—'}` : '—'} />
            <DetailItem label="Ask" value={tick.sp != null ? `${formatInr(tick.sp)} × ${tick.bs ?? '—'}` : '—'} />
            <DetailItem label="OI" value={tick.oi?.toLocaleString('en-IN') || '—'} />
            <DetailItem label="Timestamp" value={toIstFull(tick.ts)} />
            <DetailItem label="Received" value={toIstFull(tick.receivedAt)} />
          </div>
          <div className="mt-3 pt-3 border-t border-border/30">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Technical Indicators</p>
            <div className="flex flex-wrap gap-2">
              {emaPeriods.map((p) => (
                <Badge key={p} variant="outline" className={cn(
                  'text-xs font-mono border-border',
                  tick.ema[p] != null ? 'text-primary bg-primary/10' : 'text-muted-foreground bg-muted/30'
                )}>
                  EMA {p}: {tick.ema[p] != null ? formatInr(tick.ema[p]) : '—'}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

function DetailItem({ label, value, color, accent }: {
  label: string; value: string; color?: string; accent?: boolean;
}) {
  return (
    <div className="rounded-lg bg-card/70 border-border px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">{label}</p>
      <p className={cn(
        'text-sm font-semibold mt-0.5 truncate',
        color || (accent ? 'text-foreground' : 'text-foreground'),
      )}>{value}</p>
    </div>
  );
}

// ─── Technical Indicator Panel ───────────────────────────────────────

function IndicatorPanel({
  selectedTick,
  emaPeriods,
  enabledPeriods,
  onTogglePeriod,
}: {
  selectedTick: EnrichedTick | null;
  emaPeriods: number[];
  enabledPeriods: Set<number>;
  onTogglePeriod: (p: number) => void;
}) {
  return (
    <Card className="border-border bg-card/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-foreground">
          <Zap className="h-4 w-4 text-primary" />
          Technical Indicators
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {emaPeriods.map((p) => (
            <button
              key={p}
              onClick={() => onTogglePeriod(p)}
              className={cn(
                'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all border',
                enabledPeriods.has(p)
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border bg-card/50 text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
            >
              EMA {p}
            </button>
          ))}
        </div>
        {selectedTick && (
          <div className="space-y-1.5 pt-2 border-t border-border/30">
            {emaPeriods.filter((p) => enabledPeriods.has(p)).map((p) => (
              <div key={p} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">EMA {p}</span>
                <span className={cn(
                  'font-mono font-semibold',
                  selectedTick.ema[p] != null ? 'text-primary' : 'text-muted-foreground/50'
                )}>
                  {selectedTick.ema[p] != null ? formatInr(selectedTick.ema[p]) : '—'}
                </span>
              </div>
            ))}
            {emaPeriods.some((p) => enabledPeriods.has(p) && selectedTick.ema[p] == null) && (
              <p className="text-[10px] text-muted-foreground/50 mt-1">
                — indicates insufficient historical data
              </p>
            )}
          </div>
        )}
        {!selectedTick && (
          <p className="text-xs text-muted-foreground/50 text-center py-2">
            Select a symbol to view indicators
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Component ──────────────────────────────────────────────────

const MAX_HISTORY = 500;
const EMA_PERIODS = DEFAULT_EMA_PERIODS;

export default function LiveTickTablePage() {
  // Core data
  const [tickHistory, setTickHistory] = useState<Map<string, TickHistory>>(new Map());
  const [latestTicks, setLatestTicks] = useState<Map<string, RawTick>>(new Map());
  const [prevLtps, setPrevLtps] = useState<Map<string, number | null>>(new Map());

  // Connection
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [tickCount, setTickCount] = useState(0);
  const [lastTickTs, setLastTickTs] = useState<string | null>(null);

  // UI state
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [enabledPeriods, setEnabledPeriods] = useState<Set<number>>(new Set([9, 20, 50]));
  const [mobileDetail, setMobileDetail] = useState<string | null>(null);

  const tickCountRef = useRef(0);
  /** Mirrors `latestTicks` so the tick listener reads fresh rows. */
  const latestTicksRef = useRef<Map<string, RawTick>>(latestTicks);
  useEffect(() => {
    latestTicksRef.current = latestTicks;
  }, [latestTicks]);
  /** Read inside the tick listener without resubscribing on pause toggles. */
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // ─── WebSocket — the SHARED browser tick session ────────────────

  useEffect(() => {
    // ONE EventSource per browser session (`subscribeTicks` handles reconnect
    // and coalescing centrally); the pause button simply ignores frames.
    const offState = subscribeSseState((s) => setConnected(Boolean(s.connected)));
    const offTicks = subscribeTicks((raw) => {
      const tick: RawTick = raw as RawTick;
      if (pausedRef.current || !tick?.symbol) return;

      setLatestTicks((prev) => {
        const next = new Map(prev);
        next.set(tick.symbol, tick);
        if (next.size > 200) {
          const firstKey = next.keys().next().value;
          if (firstKey) next.delete(firstKey);
        }
        return next;
      });

      setTickHistory((prev) => {
        const next = new Map(prev);
        const existing = next.get(tick.symbol) || { ticks: [], emaValues: {} };
        const newTicks = [...existing.ticks, tick.ltp].filter((v): v is number => v != null);
        if (newTicks.length > MAX_HISTORY) newTicks.splice(0, newTicks.length - MAX_HISTORY);
        next.set(tick.symbol, {
          ticks: newTicks,
          emaValues: computeEmas(newTicks, EMA_PERIODS),
        });
        return next;
      });

      setPrevLtps((prev) => {
        const next = new Map(prev);
        const old = latestTicksRef.current.get(tick.symbol);
        if (old?.ltp != null && old.ltp !== tick.ltp) {
          next.set(tick.symbol, old.ltp);
        } else if (!next.has(tick.symbol)) {
          next.set(tick.symbol, null);
        }
        return next;
      });

      tickCountRef.current += 1;
      setTickCount(tickCountRef.current);
      setLastTickTs(tick.ts || tick.receivedAt || null);
    });

    return () => {
      offState();
      offTicks();
    };
  }, []);

  // Load recent ticks on mount for EMA seeding
  useEffect(() => {
    getRecentTicks(300).then((data) => {
      if (data?.ticks && Array.isArray(data.ticks)) {
        const historyMap = new Map<string, TickHistory>();
        const tickMap = new Map<string, RawTick>();

        for (const t of data.ticks) {
          tickMap.set(t.symbol, t);
          const existing = historyMap.get(t.symbol) || { ticks: [], emaValues: {} };
          if (t.ltp != null) existing.ticks.push(t.ltp);
          historyMap.set(t.symbol, existing);
        }

        // Compute EMAs for historical data
        for (const [, hist] of historyMap) {
          hist.emaValues = computeEmas(hist.ticks, EMA_PERIODS);
        }

        setTickHistory(historyMap);
        setLatestTicks(tickMap);
      }
    }).catch(() => {});
  }, []);

  // ─── Derived Data ──────────────────────────────────────────────

  const enrichedTicks = useMemo(() => {
    const result: EnrichedTick[] = [];
    for (const [symbol, raw] of latestTicks) {
      const hist = tickHistory.get(symbol);
      result.push({
        symbol: raw.symbol,
        tradingSymbol: raw.tradingSymbol,
        instrumentToken: raw.instrumentToken,
        exchangeSegment: raw.exchangeSegment,
        ltp: raw.ltp,
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: raw.volume,
        ltq: raw.ltq,
        tbq: raw.tbq,
        tsq: raw.tsq,
        bp: raw.bp,
        sp: raw.sp,
        bq: raw.bq,
        bs: raw.bs,
        averagePrice: raw.averagePrice ?? null,
        change: raw.change,
        changePercent: raw.changePercent,
        oi: raw.oi,
        ts: raw.ts,
        receivedAt: raw.receivedAt,
        ema: hist?.emaValues || {},
        prevLtp: prevLtps.get(symbol) ?? null,
      });
    }
    return result;
  }, [latestTicks, tickHistory, prevLtps]);

  const filtered = useMemo(() => {
    let result = enrichedTicks;
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter((t) =>
        t.symbol.toLowerCase().includes(q) ||
        (t.tradingSymbol || '').toLowerCase().includes(q) ||
        t.instrumentToken.includes(q)
      );
    }
    return result;
  }, [enrichedTicks, filter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'symbol': cmp = a.symbol.localeCompare(b.symbol); break;
        case 'ltp': cmp = (a.ltp ?? 0) - (b.ltp ?? 0); break;
        case 'wap': cmp = (a.averagePrice ?? 0) - (b.averagePrice ?? 0); break;
        case 'volume': cmp = (a.volume ?? 0) - (b.volume ?? 0); break;
        case 'change': cmp = (a.change ?? 0) - (b.change ?? 0); break;
        case 'changePercent': cmp = (a.changePercent ?? 0) - (b.changePercent ?? 0); break;
        case 'ts': cmp = new Date(a.ts).getTime() - new Date(b.ts).getTime(); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const stale = isStale(lastTickTs, 15000);
  const reconnecting = !connected && !paused;

  // ─── Handlers ──────────────────────────────────────────────────

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleExpand = (symbol: string) => {
    setExpandedRow((prev) => prev === symbol ? null : symbol);
    setSelectedSymbol(symbol);
  };

  const togglePeriod = (p: number) => {
    setEnabledPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  };

  const selectedTick = selectedSymbol ? enrichedTicks.find((t) => t.symbol === selectedSymbol) || null : null;

  // ─── Sort Header ───────────────────────────────────────────────

  function SortHeader({ label, sortFor }: { label: string; sortFor: SortKey }) {
    const active = sortKey === sortFor;
    return (
      <th
        className={cn(
          'text-right cursor-pointer select-none hover:text-foreground transition-colors px-3 py-2.5',
          active && 'text-primary'
        )}
        onClick={() => handleSort(sortFor)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {active ? (
            sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-30" />
          )}
        </span>
      </th>
    );
  }

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Tick Table</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Real-time WebSocket market data from Kotak
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Connection Status */}
          <Badge
            variant="outline"
            className={cn(
              'text-xs gap-1.5 border-border',
              connected && !stale
                ? 'text-success bg-success/10'
                : paused
                ? 'text-warning bg-warning/10'
                : 'text-destructive bg-destructive/10'
            )}
          >
            <span className={cn(
              'h-2 w-2 rounded-full',
              connected && !stale ? 'bg-success animate-pulse' : paused ? 'bg-warning' : 'bg-destructive'
            )} />
            {connected && !stale ? 'LIVE' : paused ? 'PAUSED' : reconnecting ? 'RECONNECTING' : 'DISCONNECTED'}
          </Badge>

          {lastTickTs && (
            <span className="text-[11px] text-muted-foreground font-mono hidden sm:inline">
              Last: {toIst(lastTickTs)}
            </span>
          )}

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs border-border"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play className="h-3.5 w-3.5 mr-1.5" /> : <Pause className="h-3.5 w-3.5 mr-1.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Table Card */}
        <Card className="flex-1 border-border bg-card/50">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-3">
                <Activity className="h-4 w-4 text-primary" />
                <span>Live Ticks</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-border text-primary bg-primary/10">
                  {sorted.length} symbols
                </Badge>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-border text-muted-foreground bg-muted/30">
                  {tickCount.toLocaleString('en-IN')} ticks
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                  <Input
                    placeholder="Filter symbol..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="h-8 w-48 pl-8 text-xs bg-card/70 border-border"
                  />
                  {filter && (
                    <button onClick={() => setFilter('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                      <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {!connected && sorted.length === 0 && !paused ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <WifiOff className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm font-medium">Waiting for Connection</p>
                <p className="text-xs mt-1 text-muted-foreground/60">
                  WebSocket is reconnecting. Ticks will appear when connected.
                </p>
              </div>
            ) : sorted.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Activity className="h-10 w-10 mb-3 opacity-30 animate-pulse" />
                <p className="text-sm font-medium">
                  {filter ? 'No matching symbols' : 'No live symbols'}
                </p>
                <p className="text-xs mt-1 text-muted-foreground/60">
                  {filter
                    ? 'Try a different search term'
                    : 'Subscribe to stocks from Stock Subscription to see live ticks'}
                </p>
              </div>
            ) : (
              <div className="overflow-auto max-h-[calc(100vh-340px)]">
                {/* Desktop Table */}
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm border-b border-border/30">
                    <tr className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      <th className="text-left px-3 py-2.5 w-8"></th>
                      <SortHeader label="Symbol" sortFor="symbol" />
                      <SortHeader label="LTP" sortFor="ltp" />
                      <SortHeader label="WAP" sortFor="wap" />
                      <SortHeader label="Volume" sortFor="volume" />
                      <SortHeader label="Change" sortFor="change" />
                      <SortHeader label="Change %" sortFor="changePercent" />
                      <SortHeader label="Time" sortFor="ts" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/20">
                    {sorted.map((tick) => {
                      const isExpanded = expandedRow === tick.symbol;
                      const isUp = (tick.change ?? 0) >= 0;
                      const isSelected = selectedSymbol === tick.symbol;
                      return (
                        <Fragment key={tick.symbol}>
                          <tr
                            className={cn(
                              'cursor-pointer transition-colors hover:bg-card/50',
                              isSelected && 'bg-card/70',
                            )}
                            onClick={() => toggleExpand(tick.symbol)}
                          >
                            <td className="px-3 py-2.5 w-8">
                              {isExpanded
                                ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40" />
                              }
                            </td>
                            <td className="px-3 py-2.5 text-left">
                              <span className="font-semibold text-foreground">{tick.symbol}</span>
                            </td>
                            <FlashCell value={tick.ltp} prevValue={tick.prevLtp} className="px-3 py-2.5 font-semibold text-foreground">
                              {formatInr(tick.ltp)}
                            </FlashCell>
                            <td className="px-3 py-2.5 text-right font-mono text-primary/80">
                              {formatInr(tick.averagePrice)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-muted-foreground" title={tick.volume?.toLocaleString('en-IN')}>
                              {formatCompact(tick.volume)}
                            </td>
                            <td className={cn('px-3 py-2.5 text-right font-mono font-medium', isUp ? 'text-success' : 'text-destructive')}>
                              {formatChange(tick.change)}
                            </td>
                            <td className={cn('px-3 py-2.5 text-right font-mono', isUp ? 'text-success' : 'text-destructive')}>
                              {formatChangePct(tick.changePercent)}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[11px] text-muted-foreground font-mono">
                              {toIst(tick.ts)}
                            </td>
                          </tr>
                          {isExpanded && (
                            <ExpandedDetails tick={tick} emaPeriods={EMA_PERIODS} />
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Side Panel — Technical Indicators */}
        <div className="lg:w-64 shrink-0">
          <IndicatorPanel
            selectedTick={selectedTick}
            emaPeriods={EMA_PERIODS}
            enabledPeriods={enabledPeriods}
            onTogglePeriod={togglePeriod}
          />
        </div>
      </div>
    </div>
  );
}

// Fragment import needed for keyed list
import { Fragment } from 'react';
