'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Layers, RefreshCw, LayoutGrid, Table as TableIcon, TrendingUp, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MetricCard, ErrorState, EmptyState } from '@/components/design-system';
import { Card, CardContent } from '@/components/ui/card';
import { useDummyState } from '@/hooks/use-dummy-state';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { useHoldingsLive, liveTickFor, seedFor } from '@/hooks/use-holdings-live';
import { LiveIndicator } from '@/components/design-system';
import { squareOffDemoPosition } from '@/lib/api';
import { getDummyHoldings, equityLabel } from '@/lib/dummy';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { cn } from '@/lib/utils';

type HoldingRow = {
  symbol: string;
  token?: string | null;
  netQuantity: number;
  averagePrice?: number | null;
  ltp?: number | null;
  currentValue?: number | null;
  pnl?: number | null;
  product?: string | null;
  buyQuantity?: number | null;
  sellQuantity?: number | null;
};

export default function DummyHoldings() {
  const { state, error, refresh } = useDummyState(2500);
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [exiting, setExiting] = useState<string | null>(null);

  // CASH holdings never appear in Positions — exit them from here.
  const exitHolding = async (symbol: string, product: string) => {
    setExiting(symbol);
    try {
      await squareOffDemoPosition(symbol, product || 'CASH');
      await refresh();
    } finally {
      setExiting(null);
    }
  };

  useEffect(() => {
    getDummyHoldings().then((res) => {
      const rows = (res?.holdings || res?.data || []) as any[];
      setHoldings(
        (Array.isArray(rows) ? rows : []).map((h) => ({
          symbol: h.symbol ?? '',
          token: h.token ?? null,
          netQuantity: h.quantity ?? h.netQuantity ?? 0,
          averagePrice: h.averageBuyPrice ?? h.averagePrice ?? null,
          ltp: h.ltp ?? null,
          currentValue: h.marketValue ?? h.currentValue ?? null,
          pnl: h.unrealizedPnl ?? h.pnl ?? null,
          product: h.product ?? null,
          buyQuantity: h.buyQuantity ?? null,
          sellQuantity: h.sellQuantity ?? null,
        })),
      );
    }).catch(() => {});
  }, [state]);

  const symbols = useMemo(() => new Set(holdings.map((h) => h.symbol)), [holdings]);
  const { latest, connected } = useLatestTicks(true);
  // Position + P&L websocket wiring: token-exact live ticks from the shared
  // stream (same pipeline as Kotak holdings).
  const live = useHoldingsLive(
    useMemo(() => holdings.map((h) => ({ token: h.token ?? null, exchangeSegment: 'nse_cm', symbol: h.symbol })), [holdings]),
    holdings.length > 0,
  );
  useEffect(() => {
    for (const sym of symbols) {
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) feedDummyLtp(sym, t.ltp);
    }
  }, [latest, symbols]);

  if (error && !state) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  const merged = holdings.map((h) => {
    // Live precedence: token-exact websocket tick → poll snapshot LTP →
    // symbol SSE tick. Value + P&L recompute from the live LTP.
    const wsTick = liveTickFor(live, h.token ?? null, h.symbol);
    const wsLtp = wsTick && wsTick.ltp > 0 ? wsTick.ltp : null;
    const liveSse = latest.get(h.symbol);
    const sseLtp = liveSse && typeof liveSse.ltp === 'number' && liveSse.ltp > 0 ? liveSse.ltp : null;
    const pollLtp = typeof h.ltp === 'number' && h.ltp > 0 ? h.ltp : null;
    const seed = seedFor(live, h.symbol);
    const seedLtp = seed && seed.ltp != null && seed.ltp > 0 ? seed.ltp : null;
    const ltp = wsLtp ?? pollLtp ?? seedLtp ?? sseLtp;
    const isLive = wsLtp != null;
    const avg = h.averagePrice ?? null;
    const qty = h.netQuantity;
    const pnl = ltp != null && avg != null && qty ? (ltp - avg) * qty : h.pnl;
    const value = ltp != null && qty ? ltp * Math.abs(qty) : h.currentValue;
    return { ...h, ltp, isLive, pnl, currentValue: value };
  });
  const liveCount = merged.filter((h) => h.isLive).length;

  const totalValue = merged.reduce((s, h) => s + (h.currentValue || 0), 0);
  const totalPnl = merged.reduce((s, h) => s + (h.pnl || 0), 0);
  const invested = merged.reduce((s, h) => s + (h.netQuantity > 0 ? (h.averagePrice || 0) * h.netQuantity : 0), 0);
  const hasCash = merged.some((h) => String(h.product || '').toUpperCase() === 'CASH');

  return (
    <DummyThemedPage>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Holdings</h1>
          <DummyBadge />
          <LiveIndicator live={live.connected || connected} label={(live.connected || connected) ? `Live · ${liveCount}/${merged.length} streaming` : 'Stream idle'} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            <Button size="sm" variant={view === 'cards' ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => setView('cards')}><LayoutGrid className="h-4 w-4" /></Button>
            <Button size="sm" variant={view === 'table' ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => setView('table')}><TableIcon className="h-4 w-4" /></Button>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetricCard icon={Layers} title="Current value" value={equityLabel(totalValue)} tone="neutral" />
        <MetricCard icon={Layers} title="Invested" value={equityLabel(invested)} tone="teal" />
        <MetricCard icon={Layers} title="Unrealized P&L" value={equityLabel(totalPnl)} tone={totalPnl >= 0 ? 'success' : 'danger'} />
      </div>

      {merged.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No holdings yet"
            description="Cash (CASH) and delivery (CNC) holdings settled here appear — never in Positions."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/trading/trade">Trade</Link>
            </Button>
          }
        />
      ) : view === 'cards' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {merged.map((h) => {
            const pnlPct = h.averagePrice && h.ltp ? ((h.ltp - h.averagePrice) / h.averagePrice) * 100 : null;
            return (
              <Card key={h.symbol} className={cn('overflow-hidden transition-shadow hover:shadow-lg', (h.pnl ?? 0) >= 0 ? 'border-t-2 border-t-emerald-500' : 'border-t-2 border-t-red-500')}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-base font-bold flex items-center gap-1.5">
                        {h.symbol}
                        {h.isLive && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" title="Live tick" />}
                      </div>
                      <div className="flex gap-1 mt-1">
                        <Badge variant="outline" className="text-[10px] mt-1">{h.product || 'CNC'}</Badge>
                        {h.isLive && <Badge className="text-[10px] mt-1 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">LIVE</Badge>}
                      </div>
                    </div>
                    {pnlPct != null && (
                      <div className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold', pnlPct >= 0 ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-500/15 text-red-500')}>
                        {pnlPct >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div><span className="text-xs text-muted-foreground">Qty</span><div className="font-semibold tabular-nums">{h.netQuantity}</div></div>
                    <div><span className="text-xs text-muted-foreground">Avg</span><div className="font-semibold tabular-nums">{h.averagePrice?.toFixed(2) ?? '—'}</div></div>
                    <div><span className="text-xs text-muted-foreground">LTP {h.isLive ? <span className="text-[9px] font-bold uppercase text-emerald-500">live</span> : null}</span><div className="font-mono font-bold tabular-nums text-base">{h.ltp?.toFixed(2) ?? '—'}</div></div>
                    <div><span className="text-xs text-muted-foreground">Value</span><div className="font-semibold tabular-nums">{h.currentValue != null ? h.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</div></div>
                  </div>
                  <div className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-sm font-semibold', (h.pnl ?? 0) >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500')}>
                    <span>P&L</span>
                    <span className="tabular-nums">{h.pnl != null ? `${h.pnl >= 0 ? '+' : ''}${h.pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</span>
                  </div>
                  {String(h.product || '').toUpperCase() === 'CASH' && (
                    <Button
                      size="sm" variant="outline" className="w-full"
                      disabled={exiting === h.symbol}
                      onClick={() => void exitHolding(h.symbol, h.product || 'CASH')}
                    >
                      {exiting === h.symbol ? 'Exiting…' : 'Sell / Exit holding'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Avg price</TableHead>
                <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">Current value</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  {hasCash && <TableHead className="text-right">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
                {merged.map((h) => (
                  <TableRow key={h.symbol}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {h.symbol}
                        {h.isLive && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" title="Live tick" />}
                      </span>
                    </TableCell>
                  <TableCell><Badge variant="outline">{h.product || 'CNC'}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums">{h.netQuantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.averagePrice?.toFixed(2) ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{h.ltp?.toFixed(2) ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{h.currentValue != null ? h.currentValue.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</TableCell>
                    <TableCell className={cn('text-right tabular-nums font-medium', h.pnl == null ? '' : h.pnl >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                      {h.pnl != null ? `${h.pnl >= 0 ? '+' : ''}${h.pnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                    </TableCell>
                    {hasCash && (
                      <TableCell className="text-right">
                        {String(h.product || '').toUpperCase() === 'CASH' ? (
                          <Button size="sm" variant="outline" disabled={exiting === h.symbol} onClick={() => void exitHolding(h.symbol, h.product || 'CASH')}>
                            {exiting === h.symbol ? 'Exiting…' : 'Sell / Exit'}
                          </Button>
                        ) : null}
                      </TableCell>
                    )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </DummyThemedPage>
  );
}