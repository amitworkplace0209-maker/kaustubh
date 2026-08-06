'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { PieChart, Search, RefreshCw, ArrowUpDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getHoldings } from '@/lib/api';

type SortField = 'symbol' | 'quantity' | 'value' | 'pnl';

export default function HoldingsPage() {
  const [holdings, setHoldings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortField>('symbol');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const fetch = useCallback(async () => {
    try {
      const data = await getHoldings();
      const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
      setHoldings(list);
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

  const filtered = useMemo(() => {
    let list = holdings;
    if (search) {
      list = list.filter((h) => (h?.trading_symbol ?? h?.symbol ?? '').toLowerCase().includes(search.toLowerCase()));
    }
    list = [...list].sort((a, b) => {
      let av: number, bv: number;
      switch (sortBy) {
        case 'quantity': av = Number(a?.quantity ?? 0); bv = Number(b?.quantity ?? 0); break;
        case 'value': av = Number(a?.quantity ?? 0) * Number(a?.avg_price ?? a?.price ?? 0); bv = Number(b?.quantity ?? 0) * Number(b?.avg_price ?? b?.price ?? 0); break;
        case 'pnl': av = Number(a?.pnl ?? 0); bv = Number(b?.pnl ?? 0); break;
        default: return (a?.trading_symbol ?? a?.symbol ?? '').localeCompare(b?.trading_symbol ?? b?.symbol ?? '') * (sortDir === 'asc' ? 1 : -1);
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }, [holdings, search, sortBy, sortDir]);

  const totalValue = holdings.reduce((sum, h) => sum + Number(h?.quantity ?? 0) * Number(h?.avg_price ?? h?.price ?? 0), 0);
  const totalPnL = holdings.reduce((sum, h) => sum + Number(h?.pnl ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Holdings</h1>
          <p className="text-sm text-muted-foreground">Your stock holdings from Kotak</p>
        </div>
        <Button size="sm" variant="ghost" onClick={fetch}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-soft card-accent-green">
          <CardContent className="p-4">
            <span className="text-sm text-muted-foreground">Total Holdings Value</span>
            <div className="text-2xl font-bold">₹{totalValue.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card className="shadow-soft card-accent-purple">
          <CardContent className="p-4">
            <span className="text-sm text-muted-foreground">Total P&L</span>
            <div className={`text-2xl font-bold ${totalPnL >= 0 ? 'text-success' : 'text-destructive'}`}>₹{totalPnL.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-soft">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Holdings ({filtered.length})</CardTitle>
          <div className="flex gap-2">
            <div className="relative w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10 h-8" />
            </div>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortField)}>
              <SelectTrigger className="w-32 h-8"><SelectValue placeholder="Sort by" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="symbol">Symbol</SelectItem>
                <SelectItem value="quantity">Quantity</SelectItem>
                <SelectItem value="value">Value</SelectItem>
                <SelectItem value="pnl">P&L</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}>
              <ArrowUpDown className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium">Symbol</th>
                  <th className="p-3 text-right font-medium">Quantity</th>
                  <th className="p-3 text-right font-medium">Avg Price</th>
                  <th className="p-3 text-right font-medium">LTP</th>
                  <th className="p-3 text-right font-medium">Value</th>
                  <th className="p-3 text-right font-medium">P&L</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Loading...</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No holdings found</td></tr>
                ) : (
                  filtered.map((h, i) => {
                    const qty = Number(h?.quantity ?? 0);
                    const avgPrice = Number(h?.avg_price ?? h?.price ?? 0);
                    const ltp = Number(h?.ltp ?? h?.last_price ?? 0);
                    const value = qty * ltp;
                    const pnl = Number(h?.pnl ?? (ltp > 0 ? (ltp - avgPrice) * qty : 0));
                    return (
                      <tr key={i} className="border-b hover:bg-muted/50 transition-colors">
                        <td className="p-3 font-medium">{h?.trading_symbol ?? h?.symbol ?? '—'}</td>
                        <td className="p-3 text-right">{qty}</td>
                        <td className="p-3 text-right text-muted-foreground">{avgPrice.toFixed(2)}</td>
                        <td className="p-3 text-right">{ltp > 0 ? ltp.toFixed(2) : '—'}</td>
                        <td className="p-3 text-right font-medium">₹{value.toLocaleString()}</td>
                        <td className={`p-3 text-right font-medium ${pnl >= 0 ? 'text-success' : 'text-destructive'}`}>₹{pnl.toLocaleString()}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
