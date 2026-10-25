'use client';

import { useMemo } from 'react';
import {
  Wallet, TrendingUp, TrendingDown, Briefcase, Layers, RefreshCw, IndianRupee,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getTradingDashboard } from '@/lib/api';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';
import { useTradingMode } from '@/lib/settings-store';

function safeNum(n: any): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function fmtINR(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PortfolioPage() {
  const mode = useTradingMode();

  // One terminal-aware envelope over the WebSocket (funds / positions /
  // holdings / orders). REST is only the fallback while the socket is down.
  const portfolio = useRealtimeChannel<Record<string, any>>('portfolio', {
    fallback: async () => ((await getTradingDashboard()) ?? {}) as Record<string, any>,
    fallbackKey: 'portfolio',
    fallbackMs: 10000,
  });

  const sections = portfolio.data?.sections;

  const holdings = useMemo(() => {
    const rows = sections?.holdings?.data;
    return Array.isArray(rows) ? rows : [];
  }, [sections]);

  const positions = useMemo(() => {
    const rows = sections?.positions?.data;
    return Array.isArray(rows) ? rows : [];
  }, [sections]);

  const funds = sections?.funds?.data ?? null;

  const loading = portfolio.loading;

  const holdingsValue = useMemo(
    () => holdings.reduce((s, h) => {
      const qty = safeNum(h?.quantity ?? 0);
      const ltp = safeNum(h?.ltp ?? h?.closingPrice ?? 0);
      const avg = safeNum(h?.averagePrice ?? (h?.holdingCost && qty > 0 ? Number(h.holdingCost) / qty : h?.avgPrice ?? 0));
      const mv = safeNum(h?.marketValue ?? h?.mktValue ?? 0);
      return s + (ltp > 0 ? qty * ltp : mv > 0 ? mv : qty * avg);
    }, 0),
    [holdings],
  );
  const holdingsPnl = useMemo(
    () => holdings.reduce((s, h) => s + safeNum(h?.unrealizedPnl ?? h?.unrealisedGainLoss ?? h?.pnl ?? 0), 0),
    [holdings],
  );
  const dayPnl = useMemo(
    () => positions.reduce((s, p) => s + safeNum(p?.unrealizedPnl ?? p?.pnl ?? 0), 0),
    [positions],
  );
  const realizedPnl = useMemo(
    () => positions.reduce((s, p) => s + safeNum(p?.realizedPnl ?? 0), 0),
    [positions],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Portfolio</h1>
          <p className="text-sm text-muted-foreground">Live holdings, positions and funds from your broker</p>
        </div>
        <Button size="sm" variant="ghost" onClick={portfolio.refresh}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Available Funds</CardTitle>
            <Wallet className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{funds ? fmtINR(safeNum(funds.freeMargin ?? funds.availableMargin ?? funds.balance ?? 0)) : '—'}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Holdings Value</CardTitle>
            <Layers className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent><div className="text-2xl font-bold">{fmtINR(holdingsValue)}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Holdings P&L</CardTitle>
            {holdingsPnl >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <TrendingDown className="h-4 w-4 text-destructive" />}
          </CardHeader>
          <CardContent><div className={`text-2xl font-bold ${holdingsPnl >= 0 ? 'text-success' : 'text-destructive'}`}>{fmtINR(holdingsPnl)}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Day P&L</CardTitle>
            <IndianRupee className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${(dayPnl + realizedPnl) >= 0 ? 'text-success' : 'text-destructive'}`}>{fmtINR(dayPnl + realizedPnl)}</div>
            <p className="text-xs text-muted-foreground">Unrealized {fmtINR(dayPnl)} · Realized {fmtINR(realizedPnl)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Briefcase className="h-4 w-4" /> Holdings ({holdings.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium">Symbol</th>
                  <th className="p-3 text-right font-medium">Qty</th>
                  <th className="p-3 text-right font-medium">Avg</th>
                  <th className="p-3 text-right font-medium">LTP</th>
                  <th className="p-3 text-right font-medium">Value</th>
                  <th className="p-3 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Loading...</td></tr>
                ) : holdings.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No holdings</td></tr>
                ) : holdings.map((h, i) => {
                  const qty = safeNum(h?.quantity ?? 0);
                  const avg = safeNum(h?.averagePrice ?? (h?.holdingCost && qty > 0 ? Number(h.holdingCost) / qty : 0));
                  const ltp = safeNum(h?.ltp ?? h?.closingPrice ?? 0);
                  const pnl = safeNum(h?.unrealizedPnl ?? h?.unrealisedGainLoss ?? h?.pnl ?? (ltp > 0 ? (ltp - avg) * qty : 0));
                  return (
                    <tr key={i} className="border-b hover:bg-muted/50 transition-colors text-sm">
                      <td className="p-3 font-medium">{h?.symbol ?? h?.tradingSymbol ?? '—'}</td>
                      <td className="p-3 text-right">{qty}</td>
                      <td className="p-3 text-right text-muted-foreground">{avg.toFixed(2)}</td>
                      <td className="p-3 text-right">{ltp > 0 ? ltp.toFixed(2) : '—'}</td>
                      <td className="p-3 text-right font-medium">{fmtINR(qty * (ltp > 0 ? ltp : (safeNum(h?.marketValue) > 0 ? safeNum(h?.marketValue) / qty : avg)))}</td>
                      <td className={`p-3 text-right font-medium ${pnl >= 0 ? 'text-success' : 'text-destructive'}`}>{fmtINR(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Open Positions ({positions.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium">Symbol</th>
                  <th className="p-3 text-left font-medium">Product</th>
                  <th className="p-3 text-right font-medium">Net Qty</th>
                  <th className="p-3 text-right font-medium">Avg</th>
                  <th className="p-3 text-right font-medium">LTP</th>
                  <th className="p-3 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No open positions</td></tr>
                ) : positions.map((p, i) => {
                  const qty = safeNum(p?.netQuantity ?? p?.netQty ?? p?.qty ?? 0);
                  const avg = safeNum(p?.netAveragePrice ?? p?.averagePrice ?? p?.avg ?? 0);
                  const ltp = safeNum(p?.ltp ?? p?.lastPrice ?? 0);
                  const pnl = safeNum(p?.unrealizedPnl ?? p?.unrealisedPnl ?? p?.pnl ?? 0);
                  return (
                    <tr key={i} className="border-b hover:bg-muted/50 transition-colors text-sm">
                      <td className="p-3 font-medium">{p?.tradingSymbol ?? p?.symbol ?? p?.sym ?? '—'}</td>
                      <td className="p-3">{p?.product ?? p?.productType ?? '—'}</td>
                      <td className="p-3 text-right">{qty}</td>
                      <td className="p-3 text-right text-muted-foreground">{avg.toFixed(2)}</td>
                      <td className="p-3 text-right">{ltp > 0 ? ltp.toFixed(2) : '—'}</td>
                      <td className={`p-3 text-right font-medium ${pnl >= 0 ? 'text-success' : 'text-destructive'}`}>{fmtINR(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
