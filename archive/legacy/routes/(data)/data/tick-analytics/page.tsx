'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart3, Activity, RefreshCw, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader, SectionCard, LoadingState, EmptyState, LiveIndicator } from '@/components/design-system';
import { getStatistics, getTickStreamUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

type TickAnalytics = {
  totalTicks: number;
  tickRate: number;
  uniqueSymbols: number;
  avgLag: number;
  symbolBreakdown: { symbol: string; ticks: number; lastTick: string }[];
};

export default function TickAnalyticsPage() {
  const [data, setData] = useState<TickAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await getStatistics();
      if (!mountedRef.current) return;
      setData({
        totalTicks: res.totalTicks ?? 0,
        tickRate: res.tickRate ?? 0,
        uniqueSymbols: res.uniqueSymbols ?? 0,
        avgLag: res.avgLag ?? 0,
        symbolBreakdown: res.symbolBreakdown ?? [],
      });
      setLoading(false);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource(getTickStreamUrl());
      es.onopen = () => { if (mountedRef.current) setConnected(true); };
      es.onerror = () => { if (mountedRef.current) setConnected(false); };
    } catch { /* ignore */ }
    return () => es?.close();
  }, []);

  if (loading) return <LoadingState />;

  if (error && !data) {
    return <EmptyState icon={BarChart3} title="Unable to load tick analytics" description={error} action={<Button size="sm" variant="outline" onClick={fetchData}><RefreshCw className="h-3 w-3 mr-1" /> Retry</Button>} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Tick Analytics" subtitle="Live market data stream analysis">
        <LiveIndicator live={connected} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total Ticks', value: data?.totalTicks.toLocaleString() ?? '—' },
          { label: 'Tick Rate', value: data ? `${data.tickRate}/s` : '—' },
          { label: 'Active Symbols', value: data?.uniqueSymbols.toString() ?? '—' },
          { label: 'Avg Latency', value: data ? `${data.avgLag}ms` : '—' },
        ].map((item) => (
          <SectionCard key={item.label}>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{item.label}</p>
            <p className="text-lg font-bold tabular-nums mt-1">{item.value}</p>
          </SectionCard>
        ))}
      </div>

      {data && data.symbolBreakdown.length > 0 ? (
        <SectionCard title="Symbol Breakdown" icon={Activity}>
          <div className="space-y-1.5">
            {data.symbolBreakdown.slice(0, 50).map((s) => (
              <div key={s.symbol} className="flex items-center justify-between text-xs py-1 border-b border-border/30 last:border-0">
                <span className="font-mono font-semibold">{s.symbol}</span>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums text-muted-foreground">{s.ticks.toLocaleString()} ticks</span>
                  <span className="tabular-nums text-muted-foreground text-[10px]">{s.lastTick ? new Date(s.lastTick).toLocaleTimeString('en-IN', { hour12: false }) : '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : (
        <EmptyState icon={BarChart3} title="No tick data yet" description="Subscribe to stocks to start collecting tick analytics" />
      )}
    </div>
  );
}
