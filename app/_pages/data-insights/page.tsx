'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, BarChart3, Columns3, RefreshCw, TrendingUp,
  TrendingDown, Zap, ArrowUpRight, ArrowDownRight, Minus, ShieldAlert,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { getStocks, getRecentTicks } from '@/lib/api';
import { subscribeSseState, subscribeTicks } from '@/lib/shared-sse';

// ─── Types ───────────────────────────────────────────────────────────

type StockEntry = {
  _id: string;
  symbol: string;
  instrumentToken: string;
  active: boolean;
};

type TickData = {
  symbol: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  change: number | null;
  changePercent: number | null;
  averagePrice?: number | null;
  ts: string;
  receivedAt?: string;
};

type Anomaly = {
  id: string;
  symbol: string;
  type: 'price_jump' | 'volume_spike' | 'price_gap';
  magnitude: string;
  timestamp: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined, decimals = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  return n.toLocaleString('en-IN');
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    hour12: false,
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
  });
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
      second: '2-digit',
    }) + ' IST';
  } catch { return '—'; }
}

function getTickBySymbol(tickMap: Map<string, TickData>, symbol: string): TickData | null {
  const sym = symbol.toUpperCase();
  return tickMap.get(sym) || null;
}

// ─── Anomaly Detection ──────────────────────────────────────────────

const prevPricesRef: Record<string, number[]> = {};
const prevVolumesRef: Record<string, number[]> = {};

function detectAnomalies(tick: TickData, allTicks: TickData[]): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const sym = tick.symbol;
  const now = tick.ts || new Date().toISOString();

  // Price jump: >2% in last 5 seconds
  if (tick.ltp != null && tick.close != null && tick.close > 0) {
    const pctChange = ((tick.ltp - tick.close) / tick.close) * 100;
    if (Math.abs(pctChange) > 2) {
      anomalies.push({
        id: `${sym}-pj-${Date.now()}`,
        symbol: sym,
        type: 'price_jump',
        magnitude: `${pctChange > 0 ? '+' : ''}${pctChange.toFixed(2)}%`,
        timestamp: now,
      });
    }
  }

  // Volume spike: volume > 3x average of recent ticks
  if (tick.volume != null && tick.volume > 0) {
    const history = prevVolumesRef[sym] || [];
    if (history.length >= 5) {
      const avgVol = history.reduce((a, b) => a + b, 0) / history.length;
      if (tick.volume > avgVol * 3) {
        anomalies.push({
          id: `${sym}-vs-${Date.now()}`,
          symbol: sym,
          type: 'volume_spike',
          magnitude: `${(tick.volume / avgVol).toFixed(1)}x avg`,
          timestamp: now,
        });
      }
    }
    prevVolumesRef[sym] = [...history.slice(-29), tick.volume];
  }

  // Price gap: LTP outside OHLC range
  if (tick.ltp != null && tick.open != null && tick.high != null && tick.low != null) {
    if (tick.ltp > tick.high || tick.ltp < tick.low) {
      anomalies.push({
        id: `${sym}-pg-${Date.now()}`,
        symbol: sym,
        type: 'price_gap',
        magnitude: tick.ltp > tick.high
          ? `+₹${(tick.ltp - tick.high).toFixed(2)} above high`
          : `₹${(tick.low - tick.ltp).toFixed(2)} below low`,
        timestamp: now,
      });
    }
  }

  return anomalies;
}

// ─── Correlation Calculation ─────────────────────────────────────────

function computeCorrelation(pricesA: number[], pricesB: number[]): number {
  const n = Math.min(pricesA.length, pricesB.length);
  if (n < 2) return 0;

  const a = pricesA.slice(-n);
  const b = pricesB.slice(-n);

  // Compute returns
  const returnsA: number[] = [];
  const returnsB: number[] = [];
  for (let i = 1; i < n; i++) {
    if (a[i - 1] !== 0) returnsA.push((a[i] - a[i - 1]) / a[i - 1]);
    if (b[i - 1] !== 0) returnsB.push((b[i] - b[i - 1]) / b[i - 1]);
  }

  const len = Math.min(returnsA.length, returnsB.length);
  if (len < 2) return 0;

  const rA = returnsA.slice(-len);
  const rB = returnsB.slice(-len);

  let sumA = 0, sumB = 0;
  for (let i = 0; i < len; i++) {
    sumA += rA[i];
    sumB += rB[i];
  }
  const meanA = sumA / len;
  const meanB = sumB / len;

  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < len; i++) {
    const dA = rA[i] - meanA;
    const dB = rB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return 0;
  return cov / denom;
}

// ─── Skeleton Sections ──────────────────────────────────────────────

function SkeletonCard() {
  return (
    <Card className="border-border bg-card/50">
      <CardHeader className="pb-3">
        <Skeleton className="h-5 w-32" />
      </CardHeader>
      <CardContent className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SkeletonTable({ rows = 4, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Card className="border-border bg-card/50">
      <CardHeader className="pb-3">
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {Array.from({ length: rows }).map((_, r) => (
            <div key={r} className="flex gap-3">
              {Array.from({ length: cols }).map((_, c) => (
                <Skeleton key={c} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Page Component ─────────────────────────────────────────────────

/** Slow stocks reconcile while the shared tick stream is live (ms). */
const STOCK_RECONCILE_MS = 60_000;

export default function DataInsightsPage() {
  // Data
  const [stocks, setStocks] = useState<StockEntry[]>([]);
  const [tickMap, setTickMap] = useState<Map<string, TickData>>(new Map());
  const [tickHistory, setTickHistory] = useState<Map<string, number[]>>(new Map());
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [volumeHistory, setVolumeHistory] = useState<Map<string, number[]>>(new Map());

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const mountedRef = useRef(true);
  /** Unsubscribers for the shared tick stream registrations. */
  const offTicksRef = useRef<(() => void) | null>(null);
  const offStateRef = useRef<(() => void) | null>(null);
  const anomalyIdSet = useRef<Set<string>>(new Set());
  const pricesRef = useRef<Map<string, number[]>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ─── Fetch stocks ───────────────────────────────────────────────

  const fetchStocks = useCallback(async () => {
    try {
      const data = await getStocks();
      const list: StockEntry[] =
        Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.stocks) ? data.stocks
        : [];
      if (mountedRef.current) {
        setStocks(list.filter((s) => s.active));
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load stocks');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // ─── Fetch recent ticks for seeding ─────────────────────────────

  const seedTicks = useCallback(async () => {
    try {
      const data = await getRecentTicks(120);
      if (!data?.ticks || !Array.isArray(data.ticks)) return;

      const tMap = new Map<string, TickData>();
      const tHist = new Map<string, number[]>();
      const vHist = new Map<string, number[]>();
      const pRef = new Map<string, number[]>();

      for (const t of data.ticks as TickData[]) {
        if (!t.symbol) continue;
        tMap.set(t.symbol, t);
        const hist = tHist.get(t.symbol) || [];
        if (t.ltp != null) hist.push(t.ltp);
        tHist.set(t.symbol, hist);

        const vHistEntry = vHist.get(t.symbol) || [];
        if (t.volume != null) vHistEntry.push(t.volume);
        vHist.set(t.symbol, vHistEntry);

        const pEntry = pRef.get(t.symbol) || [];
        if (t.ltp != null) pEntry.push(t.ltp);
        pRef.set(t.symbol, pEntry);
      }

      if (mountedRef.current) {
        setTickMap(tMap);
        setTickHistory(tHist);
        setVolumeHistory(vHist);
        pricesRef.current = pRef;
        setLastUpdated(Date.now());
      }
    } catch { /* ignore */ }
  }, []);

  // ─── SSE stream — the SHARED browser tick session ───────────────

  const [streamConnected, setStreamConnected] = useState(false);
  /** Read inside the interval callback without re-installing the timer. */
  const streamConnectedRef = useRef(false);
  streamConnectedRef.current = streamConnected;
  const connectStream = useCallback(() => {
    // One SSE session for the whole app (shared reconnect + coalescing) — this
    // page only registers a listener, it never opens its own EventSource.
    offStateRef.current = subscribeSseState((s) => setStreamConnected(Boolean(s.connected)));
    offTicksRef.current = subscribeTicks((raw) => {
      const tick = raw as TickData;
      if (!tick?.symbol || tick.ltp == null) return;

      const sym = tick.symbol;

      // Update tick map
      setTickMap((prev) => {
        const next = new Map(prev);
        next.set(sym, tick);
        return next;
      });

        // Update price history (keep last 60 entries for correlation)
        setTickHistory((prev) => {
          const next = new Map(prev);
          const hist = next.get(sym) || [];
          const updated = [...hist, ...(tick.ltp != null ? [tick.ltp] : [])].slice(-60);
          next.set(sym, updated);
          return next;
        });

        // Update price ref for anomaly detection
        const pHist = pricesRef.current.get(sym) || [];
        const newPHist = [...pHist, ...(tick.ltp != null ? [tick.ltp] : [])].slice(-30);
        pricesRef.current.set(sym, newPHist);

        // Update volume history
        setVolumeHistory((prev) => {
          const next = new Map(prev);
          const hist = next.get(sym) || [];
          if (tick.volume != null) {
            const updated = [...hist, tick.volume].slice(-30);
            next.set(sym, updated);
          }
          return next;
        });

        // Detect anomalies
        const newAnomalies = detectAnomalies(tick, []);
        if (newAnomalies.length > 0) {
          setAnomalies((prev) => {
            const filtered = newAnomalies.filter((a) => !anomalyIdSet.current.has(a.id));
            if (filtered.length === 0) return prev;
            filtered.forEach((a) => anomalyIdSet.current.add(a.id));
            return [...filtered, ...prev].slice(0, 100);
          });
        }

        setLastUpdated(Date.now());
    });
  }, []);

  // ─── Init ───────────────────────────────────────────────────────

  useEffect(() => {
    let lastStockLoad = Date.now();
    fetchStocks();
    connectStream();
    void seedTicks();

    // The subscription list only changes on user CRUD (this page edits it) and
    // the ticks themselves arrive over the SSE stream, so 15 s re-fetch churn
    // buys nothing. Reconcile slowly while the stream is live, fast when it is
    // not, and reload on re-focus.
    const stockInterval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (streamConnectedRef.current && Date.now() - lastStockLoad < STOCK_RECONCILE_MS) return;
      lastStockLoad = Date.now();
      void fetchStocks();
    }, 15000);
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      lastStockLoad = Date.now();
      void fetchStocks();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(stockInterval);
      window.removeEventListener('focus', onFocus);
      offTicksRef.current?.();
      offStateRef.current?.();
    };
  }, [fetchStocks, seedTicks, connectStream]);

  // ─── Derived: Market Movers ─────────────────────────────────────

  const activeTicks = stocks
    .map((s) => ({ stock: s, tick: getTickBySymbol(tickMap, s.symbol) }))
    .filter((e): e is { stock: StockEntry; tick: TickData } => e.tick != null);

  const topGainer = activeTicks.reduce<{ stock: StockEntry; tick: TickData } | null>((best, cur) => {
    if (cur.tick.changePercent == null) return best;
    if (!best || best.tick.changePercent == null || cur.tick.changePercent > best.tick.changePercent) return cur;
    return best;
  }, null);

  const topLoser = activeTicks.reduce<{ stock: StockEntry; tick: TickData } | null>((best, cur) => {
    if (cur.tick.changePercent == null) return best;
    if (!best || best.tick.changePercent == null || cur.tick.changePercent < best.tick.changePercent) return cur;
    return best;
  }, null);

  const mostActive = activeTicks.reduce<{ stock: StockEntry; tick: TickData } | null>((best, cur) => {
    if (cur.tick.volume == null) return best;
    if (!best || best.tick.volume == null || cur.tick.volume > best.tick.volume) return cur;
    return best;
  }, null);

  // ─── Derived: Price Range Analysis ──────────────────────────────

  const priceRangeData = activeTicks.map(({ stock, tick }) => {
    const low = tick.low ?? 0;
    const high = tick.high ?? 0;
    const ltp = tick.ltp ?? 0;
    const range = high - low;
    const position = range > 0 ? ((ltp - low) / range) * 100 : 50;
    const volatility = low > 0 ? (range / ltp) * 100 : 0;

    return {
      symbol: stock.symbol,
      low,
      high,
      ltp,
      position: Math.min(100, Math.max(0, position)),
      volatility,
    };
  }).sort((a, b) => b.volatility - a.volatility);

  // ─── Derived: Volume Profile ────────────────────────────────────

  const volumeData = activeTicks.map(({ stock, tick }) => {
    const hist = volumeHistory.get(stock.symbol) || [];
    const avgVol = hist.length > 0
      ? hist.reduce((a, b) => a + b, 0) / hist.length
      : tick.volume ?? 0;
    const relVol = avgVol > 0 && tick.volume != null ? tick.volume / avgVol : 1;

    return {
      symbol: stock.symbol,
      volume: tick.volume ?? 0,
      avgVolume: avgVol,
      relativeVolume: relVol,
    };
  }).sort((a, b) => b.volume - a.volume).slice(0, 15);

  const maxVolume = volumeData.length > 0
    ? Math.max(...volumeData.map((v) => v.volume), 1)
    : 1;

  // ─── Derived: Correlation Matrix ────────────────────────────────

  const corrSymbols = stocks
    .filter((s) => {
      const hist = tickHistory.get(s.symbol);
      return hist && hist.length >= 3;
    })
    .map((s) => s.symbol)
    .slice(0, 8);

  const correlationGrid = corrSymbols.map((symA) =>
    corrSymbols.map((symB) => {
      if (symA === symB) return 1;
      const histA = tickHistory.get(symA) || [];
      const histB = tickHistory.get(symB) || [];
      return computeCorrelation(histA, histB);
    })
  );

  // ─── Render ─────────────────────────────────────────────────────

  const lastUpdatedLabel = lastUpdated != null
    ? new Date(lastUpdated).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '—';

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Data Insights</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Market data patterns, correlations, and anomalies across {activeTicks.length} subscribed stocks
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground font-mono hidden sm:inline">
            Updated {lastUpdatedLabel}
          </span>
          <Button size="sm" variant="ghost" onClick={() => { fetchStocks(); seedTicks(); }}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Error banner ────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-4 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm font-normal text-destructive">{error}</p>
          <Button size="sm" variant="outline" className="ml-auto h-7 shrink-0" onClick={fetchStocks}>
            Retry
          </Button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SECTION 1 — Market Movers
          ══════════════════════════════════════════════════════ */}
      <section aria-label="Market movers">
        {loading ? (
          <div className="grid gap-4 md:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {/* Top Gainer */}
            <Card className="border-border bg-card/50 relative overflow-hidden">
              <span className="absolute inset-x-0 top-0 h-[2px] bg-success" />
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-success" /> Top Gainer
                </CardTitle>
                <Badge className="bg-success text-success-foreground text-[10px]">BEST</Badge>
              </CardHeader>
              <CardContent>
                {topGainer ? (
                  <div className="space-y-2">
                    <p className="text-2xl font-bold text-foreground">{topGainer.stock.symbol}</p>
                    <p className="font-mono text-lg text-foreground">₹{fmtNum(topGainer.tick.ltp)}</p>
                    <div className="flex items-center gap-2">
                      <ArrowUpRight className="h-4 w-4 text-success" />
                      <span className="font-mono text-success font-medium">
                        +{fmtNum(topGainer.tick.changePercent)}%
                      </span>
                      <span className="text-muted-foreground text-xs">
                        (₹{fmtNum(topGainer.tick.change)})
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2 border-t border-border/40">
                      <div><span className="block">High</span><span className="font-mono text-foreground">₹{fmtNum(topGainer.tick.high)}</span></div>
                      <div><span className="block">Volume</span><span className="font-mono text-foreground">{fmtCompact(topGainer.tick.volume)}</span></div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">No data</p>
                )}
              </CardContent>
            </Card>

            {/* Top Loser */}
            <Card className="border-border bg-card/50 relative overflow-hidden">
              <span className="absolute inset-x-0 top-0 h-[2px] bg-destructive" />
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingDown className="h-5 w-5 text-destructive" /> Top Loser
                </CardTitle>
                <Badge variant="destructive" className="text-[10px]">LOW</Badge>
              </CardHeader>
              <CardContent>
                {topLoser ? (
                  <div className="space-y-2">
                    <p className="text-2xl font-bold text-foreground">{topLoser.stock.symbol}</p>
                    <p className="font-mono text-lg text-foreground">₹{fmtNum(topLoser.tick.ltp)}</p>
                    <div className="flex items-center gap-2">
                      <ArrowDownRight className="h-4 w-4 text-destructive" />
                      <span className="font-mono text-destructive font-medium">
                        {fmtNum(topLoser.tick.changePercent)}%
                      </span>
                      <span className="text-muted-foreground text-xs">
                        (₹{fmtNum(topLoser.tick.change)})
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2 border-t border-border/40">
                      <div><span className="block">Low</span><span className="font-mono text-foreground">₹{fmtNum(topLoser.tick.low)}</span></div>
                      <div><span className="block">Volume</span><span className="font-mono text-foreground">{fmtCompact(topLoser.tick.volume)}</span></div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">No data</p>
                )}
              </CardContent>
            </Card>

            {/* Most Active */}
            <Card className="border-border bg-card/50 relative overflow-hidden">
              <span className="absolute inset-x-0 top-0 h-[2px] bg-primary" />
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-5 w-5 text-primary" /> Most Active
                </CardTitle>
                <Badge variant="secondary" className="text-[10px]">VOL</Badge>
              </CardHeader>
              <CardContent>
                {mostActive ? (
                  <div className="space-y-2">
                    <p className="text-2xl font-bold text-foreground">{mostActive.stock.symbol}</p>
                    <p className="font-mono text-lg text-foreground">₹{fmtNum(mostActive.tick.ltp)}</p>
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 text-primary" />
                      <span className="font-mono text-primary font-medium">
                        {fmtCompact(mostActive.tick.volume)} shares
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground pt-2 border-t border-border/40">
                      <div>
                        <span className="block">Change</span>
                        <span className={`font-mono ${(mostActive.tick.changePercent ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {(mostActive.tick.changePercent ?? 0) >= 0 ? '+' : ''}{fmtNum(mostActive.tick.changePercent)}%
                        </span>
                      </div>
                      <div>
                        <span className="block">WAP</span>
                        <span className="font-mono text-foreground">₹{fmtNum(mostActive.tick.averagePrice)}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">No data</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION 2 — Price Range Analysis
          ══════════════════════════════════════════════════════ */}
      <section aria-label="Price range analysis">
        {loading ? (
          <SkeletonTable rows={5} cols={5} />
        ) : (
          <Card className="border-border bg-card/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Columns3 className="h-5 w-5 text-primary" /> Price Range Analysis
              </CardTitle>
              <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                {priceRangeData.length} stocks
              </Badge>
            </CardHeader>
            <CardContent>
              {priceRangeData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No tick data available</p>
              ) : (
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Symbol</TableHead>
                        <TableHead className="text-right">Day Low</TableHead>
                        <TableHead className="text-right">Day High</TableHead>
                        <TableHead className="text-right">LTP</TableHead>
                        <TableHead className="text-center">Range Position</TableHead>
                        <TableHead className="text-right">Volatility</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {priceRangeData.map((row) => (
                        <TableRow key={row.symbol}>
                          <TableCell className="font-medium">{row.symbol}</TableCell>
                          <TableCell className="text-right font-mono text-destructive">₹{fmtNum(row.low)}</TableCell>
                          <TableCell className="text-right font-mono text-success">₹{fmtNum(row.high)}</TableCell>
                          <TableCell className="text-right font-mono text-foreground">₹{fmtNum(row.ltp)}</TableCell>
                          <TableCell className="text-center">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-muted-foreground w-8">0%</span>
                              <div className="relative flex-1 h-2 rounded-full bg-muted/60 overflow-hidden">
                                <div
                                  className="absolute inset-y-0 left-0 rounded-full bg-primary/30"
                                  style={{ width: `${row.position}%` }}
                                />
                                <div
                                  className="absolute top-1/2 -translate-y-1/2 h-3 w-1.5 rounded-full bg-primary shadow-sm"
                                  style={{ left: `calc(${row.position}% - 3px)` }}
                                />
                              </div>
                              <span className="text-[10px] text-muted-foreground w-8 text-right">100%</span>
                            </div>
                            <span className="text-[10px] font-mono text-muted-foreground mt-0.5 block">
                              {row.position.toFixed(0)}%
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <span className={`font-mono text-xs ${
                              row.volatility > 3 ? 'text-destructive' : row.volatility > 1.5 ? 'text-warning' : 'text-success'
                            }`}>
                              {row.volatility.toFixed(2)}%
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION 3 — Volume Profile
          ══════════════════════════════════════════════════════ */}
      <section aria-label="Volume profile">
        {loading ? (
          <SkeletonTable rows={6} cols={4} />
        ) : (
          <Card className="border-border bg-card/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-info" /> Volume Profile
              </CardTitle>
              <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                Relative to average
              </Badge>
            </CardHeader>
            <CardContent>
              {volumeData.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No volume data available</p>
              ) : (
                <div className="space-y-3">
                  {volumeData.map((row) => {
                    const barPct = maxVolume > 0 ? (row.volume / maxVolume) * 100 : 0;
                    const relPct = Math.min(row.relativeVolume, 5);
                    return (
                      <div key={row.symbol} className="group">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-foreground w-24">{row.symbol}</span>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="font-mono text-muted-foreground">{fmtCompact(row.volume)}</span>
                            <span className={`font-mono ${
                              row.relativeVolume > 2 ? 'text-destructive' : row.relativeVolume > 1.3 ? 'text-warning' : 'text-muted-foreground'
                            }`}>
                              {row.relativeVolume.toFixed(1)}x
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1 h-5 rounded bg-muted/40 overflow-hidden">
                            <div
                              className={`absolute inset-y-0 left-0 rounded transition-all duration-500 ${
                                row.relativeVolume > 2 ? 'bg-destructive/40' : row.relativeVolume > 1.3 ? 'bg-warning/40' : 'bg-primary/30'
                              }`}
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION 4 — Correlation Matrix
          ══════════════════════════════════════════════════════ */}
      <section aria-label="Correlation matrix">
        {loading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : (
          <Card className="border-border bg-card/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-5 w-5 text-info" /> Correlation Matrix
              </CardTitle>
              <Badge variant="outline" className="text-[10px] border-border text-muted-foreground">
                Last 60s price changes
              </Badge>
            </CardHeader>
            <CardContent>
              {corrSymbols.length < 2 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Need at least 2 stocks with tick history to compute correlations
                </p>
              ) : (
                <div className="overflow-auto">
                  <div className="inline-block min-w-max">
                    {/* Header row */}
                    <div className="flex">
                      <div className="w-24 shrink-0" />
                      {corrSymbols.map((sym) => (
                        <div
                          key={sym}
                          className="w-16 text-center text-[10px] font-semibold text-muted-foreground px-1 pb-2 truncate"
                          title={sym}
                        >
                          {sym}
                        </div>
                      ))}
                    </div>

                    {/* Grid */}
                    {corrSymbols.map((rowSym, i) => (
                      <div key={rowSym} className="flex items-center">
                        <div className="w-24 shrink-0 text-[10px] font-semibold text-muted-foreground pr-2 truncate" title={rowSym}>
                          {rowSym}
                        </div>
                        {corrSymbols.map((colSym, j) => {
                          const corr = correlationGrid[i]?.[j] ?? 0;
                          const absVal = Math.abs(corr);
                          let bgClass = 'bg-muted/20';
                          let textClass = 'text-muted-foreground';

                          if (i === j) {
                            bgClass = 'bg-primary/20';
                            textClass = 'text-primary';
                          } else if (corr > 0.3) {
                            bgClass = 'bg-success/20';
                            textClass = 'text-success';
                          } else if (corr < -0.3) {
                            bgClass = 'bg-destructive/20';
                            textClass = 'text-destructive';
                          } else if (corr > 0) {
                            bgClass = 'bg-success/[0.08]';
                            textClass = 'text-success';
                          } else if (corr < 0) {
                            bgClass = 'bg-destructive/[0.08]';
                            textClass = 'text-destructive';
                          }

                          return (
                            <div
                              key={colSym}
                              className={`w-16 h-12 flex items-center justify-center rounded-sm mx-px text-[10px] font-mono font-medium transition-colors ${bgClass} ${textClass}`}
                              title={`${rowSym} × ${colSym}: ${corr.toFixed(3)}`}
                            >
                              {i === j ? '1.00' : corr.toFixed(2)}
                            </div>
                          );
                        })}
                      </div>
                    ))}

                    {/* Legend */}
                    <div className="flex items-center gap-4 mt-3 pt-2 border-t border-border/30">
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="h-3 w-3 rounded-sm bg-success/20" /> Positive (&gt;0)
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="h-3 w-3 rounded-sm bg-destructive/20" /> Negative (&lt;0)
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span className="h-3 w-3 rounded-sm bg-primary/20" /> Self
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════
          SECTION 5 — Anomaly Detection
          ══════════════════════════════════════════════════════ */}
      <section aria-label="Anomaly detection">
        {loading ? (
          <SkeletonTable rows={3} cols={4} />
        ) : (
          <Card className="border-border bg-card/50">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-warning" /> Anomaly Detection
              </CardTitle>
              <Badge
                variant={anomalies.length > 0 ? 'destructive' : 'outline'}
                className={`text-[10px] ${anomalies.length === 0 ? 'border-border text-muted-foreground' : ''}`}
              >
                {anomalies.length} detected
              </Badge>
            </CardHeader>
            <CardContent>
              {anomalies.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <ShieldAlert className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-sm font-medium">No anomalies detected</p>
                  <p className="text-xs mt-1 text-muted-foreground/60">
                    Monitoring for price jumps (&gt;2%), volume spikes, and price gaps
                  </p>
                </div>
              ) : (
                <div className="overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Magnitude</TableHead>
                        <TableHead className="text-right">Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {anomalies.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="font-medium">{a.symbol}</TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`text-[10px] border-border ${
                                a.type === 'price_jump' ? 'text-destructive bg-destructive/10'
                                : a.type === 'volume_spike' ? 'text-warning bg-warning/10'
                                : 'text-info bg-info/10'
                              }`}
                            >
                              {a.type === 'price_jump' && <ArrowUpRight className="h-3 w-3 mr-1" />}
                              {a.type === 'volume_spike' && <BarChart3 className="h-3 w-3 mr-1" />}
                              {a.type === 'price_gap' && <Minus className="h-3 w-3 mr-1" />}
                              {a.type === 'price_jump' ? 'Price Jump' : a.type === 'volume_spike' ? 'Volume Spike' : 'Price Gap'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{a.magnitude}</TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground font-mono">
                            {toIst(a.timestamp)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
