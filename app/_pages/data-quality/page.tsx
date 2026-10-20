'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Eye, Gauge, RefreshCw, ShieldAlert, XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { getStocks, getRecentTicks } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';

// ─── Types ──────────────────────────────────────────────────────────

interface Stock {
  symbol: string;
  tradingSymbol?: string;
  instrumentToken?: string;
  exchangeSegment?: string;
  active?: boolean;
}

interface TickData {
  symbol: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  averagePrice: number | null;
  change: number | null;
  changePercent: number | null;
  oi?: number | null;
  ts: string;
  receivedAt?: string;
}

interface StockQuality {
  symbol: string;
  lastTickAge: number | null;
  freshness: 'fresh' | 'stale' | 'no-data';
  fieldsPresent: number;
  totalFields: number;
  priceValid: boolean;
  issues: string[];
  tick: TickData | null;
}

interface QualityIssue {
  id: string;
  severity: 'warning' | 'error';
  symbol: string;
  description: string;
  timestamp: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const EXPECTED_FIELDS = [
  'symbol', 'ltp', 'open', 'high', 'low', 'close',
  'volume', 'averagePrice', 'change', 'changePercent', 'oi',
];

const FRESHNESS_THRESHOLDS = { fresh: 5000, stale: 30000 };

// ─── Helpers ────────────────────────────────────────────────────────

function getTickAgeMs(tick: TickData | null): number | null {
  if (!tick?.ts) return null;
  try {
    const ts = new Date(tick.ts).getTime();
    if (isNaN(ts)) return null;
    return Date.now() - ts;
  } catch {
    return null;
  }
}

function freshnessStatus(ageMs: number | null): StockQuality['freshness'] {
  if (ageMs == null) return 'no-data';
  if (ageMs < FRESHNESS_THRESHOLDS.fresh) return 'fresh';
  if (ageMs < FRESHNESS_THRESHOLDS.stale) return 'stale';
  return 'no-data';
}

function countFields(tick: TickData | null): number {
  if (!tick) return 0;
  let count = 0;
  for (const field of EXPECTED_FIELDS) {
    const val = (tick as any)[field];
    if (val != null && val !== '') count++;
  }
  return count;
}

function isPriceValid(tick: TickData | null): boolean {
  if (!tick) return false;
  const { ltp, open, high, low, close } = tick;
  if (ltp == null || ltp <= 0) return false;
  if (open == null || high == null || low == null || close == null) return true;
  if (ltp < low || ltp > high) return false;
  if (high < low) return false;
  return true;
}

function fmtAge(ms: number | null): string {
  if (ms == null) return 'No data';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function freshnessBadge(status: StockQuality['freshness']) {
  switch (status) {
    case 'fresh':
      return <Badge variant="outline" className="text-[10px] border-success/30 bg-success/10 text-success">Fresh</Badge>;
    case 'stale':
      return <Badge variant="outline" className="text-[10px] border-warning/30 bg-warning/10 text-warning">Stale</Badge>;
    default:
      return <Badge variant="outline" className="text-[10px] border-destructive/30 bg-destructive/10 text-destructive">No Data</Badge>;
  }
}

function priceBadge(valid: boolean) {
  return valid
    ? <Badge variant="outline" className="text-[10px] border-success/30 bg-success/10 text-success">Valid</Badge>
    : <Badge variant="outline" className="text-[10px] border-destructive/30 bg-destructive/10 text-destructive">Invalid</Badge>;
}

function severityBadge(severity: QualityIssue['severity']) {
  if (severity === 'error') {
    return <Badge variant="outline" className="text-[10px] border-destructive/30 bg-destructive/10 text-destructive gap-1"><XCircle className="h-3 w-3" /> Error</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] border-warning/30 bg-warning/10 text-warning gap-1"><AlertTriangle className="h-3 w-3" /> Warning</Badge>;
}

// ─── Score Card ─────────────────────────────────────────────────────

function ScoreCard({
  icon: Icon,
  title,
  score,
  loading,
  color,
}: {
  icon: React.ElementType;
  title: string;
  score: number | null;
  loading: boolean;
  color: string;
}) {
  const pct = score != null && Number.isFinite(score) ? Math.round(score) : null;
  const statusColor = pct == null ? 'text-muted-foreground' : pct >= 90 ? 'text-success' : pct >= 60 ? 'text-warning' : 'text-destructive';
  const barColor = pct == null ? 'bg-muted' : pct >= 90 ? 'bg-success' : pct >= 60 ? 'bg-warning' : 'bg-destructive';

  return (
    <Card className="border-border bg-card/50">
      <CardContent className="p-4">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-2 w-full" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg', color)}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium text-foreground">{title}</span>
            </div>
            <p className={cn('text-2xl font-bold tabular-nums', statusColor)}>
              {pct != null ? `${pct}%` : '—'}
            </p>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-500', barColor)}
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function DataQualityPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [ticks, setTicks] = useState<Map<string, TickData>>(new Map());
  const [tickBuckets, setTickBuckets] = useState<number[]>([]);
  const { onFrame } = useFrontendRealtime();
  const lastRefreshRef = useRef(0);

  const fetchData = useCallback(async () => {
    try {
      setError(null);

      const [stocksRes, ticksRes] = await Promise.allSettled([
        getStocks(),
        getRecentTicks(200),
      ]);

      const stockList: Stock[] = [];
      if (stocksRes.status === 'fulfilled') {
        const data = stocksRes.value;
        if (Array.isArray(data)) {
          stockList.push(...data);
        } else if (data?.stocks && Array.isArray(data.stocks)) {
          stockList.push(...data.stocks);
        } else if (data?.data && Array.isArray(data.data)) {
          stockList.push(...data.data);
        }
      }
      setStocks(stockList);

      const tickMap = new Map<string, TickData>();
      if (ticksRes.status === 'fulfilled') {
        const data = ticksRes.value;
        const tickArr: TickData[] = Array.isArray(data) ? data : data?.ticks ?? data?.data ?? [];
        for (const t of tickArr) {
          if (t?.symbol) tickMap.set(t.symbol, t);
        }
      }
      setTicks(tickMap);

      // Build 10-minute tick buckets
      const now = Date.now();
      const buckets: number[] = new Array(10).fill(0);
      for (const [, t] of tickMap) {
        if (!t.ts) continue;
        try {
          const age = now - new Date(t.ts).getTime();
          const minuteIndex = Math.floor(age / 60_000);
          if (minuteIndex >= 0 && minuteIndex < 10) {
            buckets[9 - minuteIndex]++;
          }
        } catch { /* skip */ }
      }
      setTickBuckets(buckets);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load data quality info');
    } finally {
      setLoading(false);
    }
  }, []);

  // No local polling timer: the page reloads on the Connection Manager push
  // cadence (engine.status), throttled to at most one reload every 5s.
  useEffect(() => {
    void fetchData();
    const off = onFrame((frame) => {
      if (frame.type !== 'engine.status') return;
      const now = Date.now();
      if (now - lastRefreshRef.current < 5000) return;
      lastRefreshRef.current = now;
      void fetchData();
    });
    return off;
  }, [fetchData, onFrame]);

  // ─── Compute quality metrics ──────────────────────────────────────

  const stockQualities: StockQuality[] = stocks.map((stock) => {
    const tick = ticks.get(stock.symbol) ?? null;
    const ageMs = getTickAgeMs(tick);
    const freshness = freshnessStatus(ageMs);
    const fieldsPresent = countFields(tick);
    const priceValid = isPriceValid(tick);
    const issues: string[] = [];

    if (freshness === 'no-data') issues.push('No tick data available');
    else if (freshness === 'stale') issues.push('Tick data is stale (>5s)');

    if (fieldsPresent < EXPECTED_FIELDS.length) {
      const missing = EXPECTED_FIELDS.filter((f) => {
        const v = (tick as any)?.[f];
        return v == null || v === '';
      });
      issues.push(`Missing fields: ${missing.join(', ')}`);
    }

    if (!priceValid) {
      if (tick?.ltp == null) issues.push('LTP is missing');
      else if (tick.ltp <= 0) issues.push('LTP is zero or negative');
      else issues.push('LTP outside OHLC range');
    }

    return {
      symbol: stock.symbol,
      lastTickAge: ageMs,
      freshness,
      fieldsPresent,
      totalFields: EXPECTED_FIELDS.length,
      priceValid,
      issues,
      tick,
    };
  });

  const validStocks = stockQualities.filter((sq) => sq.freshness !== 'no-data');
  const totalStocks = stockQualities.length || 1;

  // Freshness score: % of stocks with fresh (<5s) ticks
  const freshnessScore = totalStocks > 0
    ? (stockQualities.filter((sq) => sq.freshness === 'fresh').length / totalStocks) * 100
    : null;

  // Completeness score: avg % of fields present across stocks with data
  const completenessScore = validStocks.length > 0
    ? validStocks.reduce((sum, sq) => sum + (sq.fieldsPresent / sq.totalFields) * 100, 0) / validStocks.length
    : null;

  // Consistency score: % of stocks with valid prices
  const consistencyScore = validStocks.length > 0
    ? (validStocks.filter((sq) => sq.priceValid).length / validStocks.length) * 100
    : null;

  // Overall score
  const overallScore = [freshnessScore, completenessScore, consistencyScore]
    .filter((s): s is number => s != null)
    .reduce((sum, s, _, arr) => sum + s / arr.length, 0) || null;

  // ─── Issues log ───────────────────────────────────────────────────

  const issuesLog: QualityIssue[] = [];
  let issueId = 0;
  for (const sq of stockQualities) {
    for (const desc of sq.issues) {
      const severity = desc.includes('No tick') || desc.includes('outside') || desc.includes('zero') || desc.includes('missing')
        ? 'error'
        : 'warning';
      issuesLog.push({
        id: `issue-${issueId++}`,
        severity,
        symbol: sq.symbol,
        description: desc,
        timestamp: sq.tick?.ts ?? new Date().toISOString(),
      });
    }
  }
  issuesLog.sort((a, b) => {
    if (a.severity === b.severity) return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    return a.severity === 'error' ? -1 : 1;
  });

  const maxBucket = Math.max(...tickBuckets, 1);

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Data Quality Monitor</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Freshness, completeness, and consistency of tick data
          </p>
        </div>
        <div className="flex items-center gap-3">
          {loading ? (
            <Skeleton className="h-6 w-32" />
          ) : overallScore != null ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Overall Score</span>
              <Badge
                variant="outline"
                className={cn(
                  'text-sm font-bold tabular-nums border-border',
                  overallScore >= 90 ? 'text-success bg-success/10' : overallScore >= 60 ? 'text-warning bg-warning/10' : 'text-destructive bg-destructive/10',
                )}
              >
                {Math.round(overallScore)}%
              </Badge>
            </div>
          ) : (
            <Badge variant="outline" className="text-sm border-border text-muted-foreground bg-muted/30">No Data</Badge>
          )}
        </div>
      </div>

      {/* Score Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ScoreCard
          icon={Clock}
          title="Freshness"
          score={freshnessScore}
          loading={loading}
          color="bg-info/10 text-info"
        />
        <ScoreCard
          icon={Eye}
          title="Completeness"
          score={completenessScore}
          loading={loading}
          color="bg-primary/10 text-primary"
        />
        <ScoreCard
          icon={ShieldAlert}
          title="Consistency"
          score={consistencyScore}
          loading={loading}
          color="bg-success/10 text-success"
        />
      </div>

      {/* Stock Quality Table */}
      <Card className="border-border bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-foreground">
            <Gauge className="h-4 w-4 text-primary" />
            Stock Quality
            {!loading && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-border text-muted-foreground bg-muted/30">
                {stockQualities.length} symbols
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </div>
          ) : stockQualities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Activity className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-sm font-medium">No stocks subscribed</p>
              <p className="text-xs mt-1 text-muted-foreground/60">
                Subscribe to stocks to monitor data quality
              </p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-420px)]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm border-b border-border/30">
                  <tr className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    <th className="text-left px-4 py-2.5">Symbol</th>
                    <th className="text-right px-4 py-2.5">Last Tick Age</th>
                    <th className="text-center px-4 py-2.5">Freshness</th>
                    <th className="text-center px-4 py-2.5">Fields</th>
                    <th className="text-center px-4 py-2.5">Price Validity</th>
                    <th className="text-left px-4 py-2.5">Issues</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/20">
                  {stockQualities.map((sq) => (
                    <tr key={sq.symbol} className="hover:bg-card/50 transition-colors">
                      <td className="px-4 py-2.5">
                        <span className="font-semibold text-foreground">{sq.symbol}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
                        {fmtAge(sq.lastTickAge)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {freshnessBadge(sq.freshness)}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={cn(
                          'font-mono text-xs',
                          sq.fieldsPresent === sq.totalFields ? 'text-success' : 'text-warning',
                        )}>
                          {sq.fieldsPresent}/{sq.totalFields}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {priceBadge(sq.priceValid)}
                      </td>
                      <td className="px-4 py-2.5">
                        {sq.issues.length === 0 ? (
                          <span className="text-xs text-success">None</span>
                        ) : (
                          <ul className="text-xs text-destructive/80 space-y-0.5">
                            {sq.issues.map((issue, i) => (
                              <li key={i} className="flex items-start gap-1">
                                <span className="text-destructive mt-0.5">•</span>
                                {issue}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bottom Row: Trends + Issues */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Quality Trends */}
        <Card className="border-border bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-foreground">
              <Activity className="h-4 w-4 text-info" />
              Tick Volume (Last 10 min)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Skeleton className="h-3 w-8" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                ))}
              </div>
            ) : tickBuckets.every((b) => b === 0) ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Activity className="h-8 w-8 mb-2 opacity-30" />
                <p className="text-xs">No tick activity in the last 10 minutes</p>
              </div>
            ) : (
              <div className="space-y-2">
                {tickBuckets.map((count, i) => {
                  const minuteAgo = 9 - i;
                  const pct = maxBucket > 0 ? (count / maxBucket) * 100 : 0;
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-muted-foreground w-8 text-right shrink-0">
                        {minuteAgo}m
                      </span>
                      <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded transition-all duration-300',
                            count > 0 ? 'bg-info' : 'bg-transparent',
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground w-8 shrink-0">
                        {count}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Issues Log */}
        <Card className="border-border bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2 text-foreground">
              <ShieldAlert className="h-4 w-4 text-warning" />
              Issues Log
              {!loading && issuesLog.length > 0 && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-border text-destructive bg-destructive/10">
                  {issuesLog.length}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                ))}
              </div>
            ) : issuesLog.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 mb-2 text-success/50" />
                <p className="text-xs font-medium">All checks passed</p>
                <p className="text-xs text-muted-foreground/60 mt-1">No data quality issues detected</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[260px] overflow-auto pr-1">
                {issuesLog.map((issue) => (
                  <div
                    key={issue.id}
                    className={cn(
                      'flex items-start gap-2 rounded-lg border px-3 py-2',
                      issue.severity === 'error'
                        ? 'border-destructive/20 bg-destructive/5'
                        : 'border-warning/20 bg-warning/5',
                    )}
                  >
                    {severityBadge(issue.severity)}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">{issue.symbol}</span>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {(() => {
                            try {
                              return new Date(issue.timestamp).toLocaleTimeString('en-IN', {
                                hour12: false,
                                timeZone: 'Asia/Kolkata',
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              });
                            } catch {
                              return '—';
                            }
                          })()}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{issue.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
