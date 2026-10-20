'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { PieChart, Search, RefreshCw, ArrowUpDown, LayoutGrid, Table as TableIcon, TrendingUp, TrendingDown, Wallet, Layers, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getTradingDashboard } from '@/lib/api';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { useHoldingsLive, liveTickFor, seedFor } from '@/hooks/use-holdings-live';
import { cn } from '@/lib/utils';

type SortField = 'symbol' | 'quantity' | 'value' | 'pnl' | 'pnlpct';

function fmtINR(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export default function HoldingsPage() {
  const [holdings, setHoldings] = useState<any[]>([]);
  const [todayPnl, setTodayPnl] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('symbol');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const { latest, connected } = useLatestTicks(true);

  // Position + P&L websocket wiring: subscribe holding tokens to the Kotak
  // SDK feed so ticks flow, then read them token-exact from the shared SSE.
  const identities = useMemo(
    () =>
      holdings.map((h) => ({
        token: h?.instrumentToken ?? h?.token ?? h?.instrument_token ?? h?.exchange_token ?? null,
        exchangeSegment: h?.exchange ?? h?.exchangeSegment ?? h?.exSeg ?? 'nse_cm',
        symbol: h?.symbol ?? h?.tradingSymbol ?? h?.trdSym ?? null,
      })),
    [holdings],
  );
  const live = useHoldingsLive(identities, holdings.length > 0);
  const liveCount = useMemo(() => {
    const seen = new Set<string>();
    for (const h of holdings) {
      const t = liveTickFor(
        live,
        h?.instrumentToken ?? h?.token ?? h?.instrument_token ?? h?.exchange_token ?? null,
        h?.symbol ?? h?.tradingSymbol ?? h?.trdSym ?? null,
        h?.tradingSymbol ?? h?.tradingsymbol ?? null,
      );
      if (t) seen.add(String(h?.symbol ?? h?.tradingSymbol ?? seen.size));
    }
    return seen.size;
  }, [holdings, live]);

  const fetch = useCallback(async () => {
    try {
      const data = await getTradingDashboard();
      const rows = data?.sections?.holdings?.data;
      setHoldings(Array.isArray(rows) ? rows : []);
      const f = data?.sections?.funds?.data;
      const mtomToday = Number(f?.raw?.RealizedMtomPrsnt ?? 0) + Number(f?.raw?.UnrealizedMtomPrsnt ?? 0);
      setTodayPnl(f?.totalPnl ?? f?.dayPnl ?? (f?.raw ? mtomToday : 0));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch]);

  const enriched = useMemo(() => holdings.map((h) => {
    const symbol = h?.symbol ?? h?.tradingSymbol ?? h?.trdSym ?? '—';
    const qty = Number(h?.quantity ?? h?.holdqty ?? h?.netQty ?? 0);
    // Per-share cost: prefer explicit averagePrice/averageBuyPrice; holdingCost is total cost.
    const avg = Number(
      h?.averagePrice ?? h?.averageBuyPrice ??
      (h?.holdingCost && qty > 0 ? Number(h.holdingCost) / qty : h?.avgPrice ?? 0),
    );
    // Live LTP precedence: token-exact websocket tick → symbol SSE tick →
    // broker snapshot → derived. The websocket tick is the live price.
    const wsTick = liveTickFor(
      live,
      h?.instrumentToken ?? h?.token ?? h?.instrument_token ?? h?.exchange_token ?? null,
      symbol,
      h?.tradingSymbol ?? h?.tradingsymbol ?? null,
    );
    const wsLtp = wsTick && wsTick.ltp > 0 ? wsTick.ltp : null;
    const sseTick = latest.get(symbol) ?? latest.get(String(symbol).toUpperCase()) ?? latest.get(`${symbol}-EQ`) ?? latest.get(h?.tradingSymbol ?? '') ?? latest.get(String(h?.tradingSymbol ?? '').split('-')[0]);
    const sseLtp = sseTick && typeof sseTick.ltp === 'number' && sseTick.ltp > 0 ? sseTick.ltp : null;
    const streamLtp = wsLtp ?? sseLtp;
    // Canonical seed (Search Engine token + LTP): instant real price even
    // before the first websocket tick, and honest fallback when the broker
    // row's own token is stale for the segment.
    const seed = seedFor(live, symbol);
    const seedLtp = seed && seed.ltp != null && seed.ltp > 0 ? seed.ltp : null;
    const brokerLtp = Number(h?.ltp ?? h?.last_price ?? h?.closingPrice ?? 0);
    const brokerValue = Number(h?.marketValue ?? h?.mktValue ?? h?.value ?? 0);
    const effLtp = streamLtp ?? seedLtp;
    const ltp = effLtp != null
      ? effLtp
      : brokerLtp > 0 ? brokerLtp : (qty > 0 && brokerValue > 0 ? brokerValue / qty : 0);
    const isLive = streamLtp != null;
    const exchange = h?.exchange ?? h?.exchangeSegment ?? h?.exSeg ?? '';
    const product = h?.product ?? h?.prod ?? '';
    const value = effLtp != null
      ? qty * effLtp
      : (brokerValue > 0 ? brokerValue : qty * (ltp > 0 ? ltp : avg));
    const invested = qty * avg;
    const pnl = effLtp != null || ltp > 0
      ? (ltp - avg) * qty
      : Number(h?.unrealizedPnl ?? h?.unrealisedGainLoss ?? h?.pnl ?? 0);
    const pnlPct = avg > 0 ? ((ltp > 0 ? ltp : avg) - avg) / avg * 100 : 0;
    return { raw: h, symbol, qty, avg, ltp, isLive, exchange, product, value, invested, pnl, pnlPct };
  }), [holdings, latest, live]);

  const filtered = useMemo(() => {
    let list = enriched;
    if (search) list = list.filter((h) => h.symbol.toLowerCase().includes(search.toLowerCase()));
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'quantity': return sortDir === 'asc' ? a.qty - b.qty : b.qty - a.qty;
        case 'value': return sortDir === 'asc' ? a.value - b.value : b.value - a.value;
        case 'pnl': return sortDir === 'asc' ? a.pnl - b.pnl : b.pnl - a.pnl;
        case 'pnlpct': return sortDir === 'asc' ? a.pnlPct - b.pnlPct : b.pnlPct - a.pnlPct;
        default: return a.symbol.localeCompare(b.symbol) * (sortDir === 'asc' ? 1 : -1);
      }
    });
    return list;
  }, [enriched, search, sortBy, sortDir]);

  const totalValue = enriched.reduce((s, h) => s + h.value, 0);
  const totalInvested = enriched.reduce((s, h) => s + h.invested, 0);
  const totalPnL = enriched.reduce((s, h) => s + h.pnl, 0);
  const totalPnLPct = totalInvested > 0 ? (totalValue - totalInvested) / totalInvested * 100 : 0;
  const best = enriched.length ? enriched.reduce((m, h) => (h.pnlPct > m.pnlPct ? h : m)) : null;
  const worst = enriched.length ? enriched.reduce((m, h) => (h.pnlPct < m.pnlPct ? h : m)) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-7 w-7 text-emerald-500" /> Holdings
          </h1>
          <p className="text-sm text-muted-foreground">
            Your stock holdings from the broker · {(live.connected || connected) ? (
              <span className="text-emerald-500 font-medium">live · {liveCount}/{enriched.length} streaming</span>
            ) : 'connecting to live feed…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5">
            <Button size="sm" variant={view === 'cards' ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => setView('cards')}><LayoutGrid className="h-4 w-4" /></Button>
            <Button size="sm" variant={view === 'table' ? 'secondary' : 'ghost'} className="h-7 px-2" onClick={() => setView('table')}><TableIcon className="h-4 w-4" /></Button>
          </div>
          <Button size="sm" variant="outline" onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}><ArrowUpDown className="h-4 w-4" /></Button>
          <Button size="sm" variant="ghost" onClick={fetch}><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <Card className="border-l-4 border-l-amber-500 bg-gradient-to-br from-amber-500/10 to-transparent">
          <CardContent className="p-4">
            <span className="text-xs text-muted-foreground">Holdings</span>
            <div className="text-2xl font-bold text-amber-500">{enriched.length}</div>
            {best && <p className="text-[11px] text-muted-foreground">Top: <span className="text-emerald-500">{best.symbol} {best.pnlPct.toFixed(1)}%</span></p>}
            {worst && worst !== best && <p className="text-[11px] text-muted-foreground">Worst: <span className="text-red-500">{worst.symbol} {worst.pnlPct.toFixed(1)}%</span></p>}
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-sky-500 bg-gradient-to-br from-sky-500/10 to-transparent">
          <CardContent className="p-4">
            <span className="text-xs text-muted-foreground">Invested</span>
            <div className="text-2xl font-bold text-sky-500">{fmtINR(totalInvested)}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500 bg-gradient-to-br from-emerald-500/10 to-transparent">
          <CardContent className="p-4">
            <span className="text-xs text-muted-foreground">Current Value</span>
            <div className="text-2xl font-bold text-emerald-500">{fmtINR(totalValue)}</div>
            <p className="text-[11px] text-muted-foreground">total stock value now</p>
          </CardContent>
        </Card>
        <Card className={cn('border-l-4 bg-gradient-to-br to-transparent', totalPnL >= 0 ? 'border-l-violet-500 from-violet-500/10' : 'border-l-red-500 from-red-500/10')}>
          <CardContent className="p-4">
            <span className="text-xs text-muted-foreground">Total P&L</span>
            <div className={cn('text-2xl font-bold', totalPnL >= 0 ? 'text-violet-500' : 'text-red-500')}>
              {totalPnL >= 0 ? '+' : ''}{fmtINR(totalPnL)}
            </div>
            <p className={cn('text-[11px]', totalPnLPct >= 0 ? 'text-emerald-500' : 'text-red-500')}>{totalPnLPct >= 0 ? '+' : ''}{totalPnLPct.toFixed(2)}%</p>
          </CardContent>
        </Card>
        <Card className={cn('border-l-4 bg-gradient-to-br to-transparent', todayPnl >= 0 ? 'border-l-rose-500 from-rose-500/10' : 'border-l-rose-500 from-rose-500/10')}>
          <CardContent className="p-4">
            <span className="text-xs text-muted-foreground">Today P&L</span>
            <div className={cn('text-2xl font-bold', todayPnl >= 0 ? 'text-emerald-500' : 'text-red-500')}>
              {todayPnl >= 0 ? '+' : ''}{fmtINR(todayPnl)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search symbol..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10 h-9" />
        </div>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortField)}>
          <SelectTrigger className="w-32 h-9"><SelectValue placeholder="Sort" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="symbol">Symbol</SelectItem>
            <SelectItem value="quantity">Quantity</SelectItem>
            <SelectItem value="value">Value</SelectItem>
            <SelectItem value="pnl">P&L</SelectItem>
            <SelectItem value="pnlpct">P&L %</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">Loading holdings…</CardContent></Card>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">No holdings found</CardContent></Card>
      ) : view === 'cards' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((h, i) => (
            <Card key={i} className={cn(
              'overflow-hidden transition-shadow hover:shadow-lg',
              h.pnl >= 0 ? 'border-t-2 border-t-emerald-500' : 'border-t-2 border-t-red-500',
            )}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-base font-bold flex items-center gap-1.5">
                      {h.symbol}
                      {h.isLive && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" title="Live tick" />}
                    </div>
                    <div className="flex gap-1 mt-1">
                      {h.exchange && <Badge variant="outline" className="text-[10px] px-1.5 py-0">{h.exchange}</Badge>}
                      {h.product && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{h.product}</Badge>}
                      {h.isLive && <Badge className="text-[10px] px-1.5 py-0 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">LIVE</Badge>}
                    </div>
                  </div>
                  <div className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold', h.pnl >= 0 ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-500/15 text-red-500')}>
                    {h.pnl >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(2)}%
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-xs text-muted-foreground">Qty</span><div className="font-semibold tabular-nums">{h.qty}</div></div>
                  <div><span className="text-xs text-muted-foreground">Avg</span><div className="font-semibold tabular-nums">{h.avg.toFixed(2)}</div></div>
                  <div><span className="text-xs text-muted-foreground">LTP {h.isLive ? <span className="text-[9px] font-bold uppercase text-emerald-500">live</span> : null}</span><div className="font-mono font-bold tabular-nums text-base">{h.ltp > 0 ? h.ltp.toFixed(2) : '—'}</div></div>
                  <div><span className="text-xs text-muted-foreground">Value</span><div className="font-semibold tabular-nums">{fmtINR(h.value)}</div></div>
                </div>
                <div className={cn('flex items-center justify-between rounded-md px-2 py-1.5 text-sm font-semibold', h.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500')}>
                  <span>P&L</span>
                  <span className="tabular-nums">{h.pnl >= 0 ? '+' : ''}{fmtINR(h.pnl)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">Holdings ({filtered.length})</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="p-3 text-left font-medium">Symbol</th>
                    <th className="p-3 text-left font-medium">Exchange</th>
                    <th className="p-3 text-right font-medium">Qty</th>
                    <th className="p-3 text-right font-medium">Avg</th>
                    <th className="p-3 text-right font-medium">LTP</th>
                    <th className="p-3 text-right font-medium">Value</th>
                    <th className="p-3 text-right font-medium">P&L</th>
                    <th className="p-3 text-right font-medium">P&L %</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((h, i) => (
                    <tr key={i} className="border-b hover:bg-muted/50 transition-colors">
                      <td className="p-3 font-bold">
                        <span className="inline-flex items-center gap-1.5">
                          {h.symbol}
                          {h.isLive && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" title="Live tick" />}
                        </span>
                      </td>
                      <td className="p-3 text-muted-foreground">{h.exchange || '—'}</td>
                      <td className="p-3 text-right tabular-nums">{h.qty}</td>
                      <td className="p-3 text-right tabular-nums text-muted-foreground">{h.avg.toFixed(2)}</td>
                      <td className="p-3 text-right font-mono tabular-nums">{h.ltp > 0 ? h.ltp.toFixed(2) : '—'}</td>
                      <td className="p-3 text-right tabular-nums font-medium">{fmtINR(h.value)}</td>
                      <td className={cn('p-3 text-right tabular-nums font-bold', h.pnl >= 0 ? 'text-emerald-500' : 'text-red-500')}>{h.pnl >= 0 ? '+' : ''}{fmtINR(h.pnl)}</td>
                      <td className={cn('p-3 text-right tabular-nums font-bold', h.pnlPct >= 0 ? 'text-emerald-500' : 'text-red-500')}>{h.pnlPct >= 0 ? '+' : ''}{h.pnlPct.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
