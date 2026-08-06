'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrendingUp, TrendingDown, RefreshCw, Filter } from 'lucide-react';
import { getGainersLosers } from '@/lib/api';

type StockMove = {
  _id: string;
  open: number;
  ltp: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
  priceChange: number;
};

const FILTERS = [
  { label: 'All', value: 0 },
  { label: '₹5+', value: 5 },
  { label: '₹10+', value: 10 },
  { label: '₹20+', value: 20 },
  { label: '₹25+', value: 25 },
];

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function StockPage() {
  const [gainers, setGainers] = useState<StockMove[]>([]);
  const [losers, setLosers] = useState<StockMove[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(0);

  const fetch = useCallback(async () => {
    try {
      const data = await getGainersLosers(filter, 20);
      setGainers(data?.gainers || []);
      setLosers(data?.losers || []);
    } catch {
      setGainers([]);
      setLosers([]);
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Stocks</h1>
          <p className="text-sm text-muted-foreground">NSE stocks — sorted by price movement in ₹ (not %)</p>
        </div>
        <Button size="sm" variant="ghost" onClick={fetch}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {/* Price filters */}
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground mr-2">Min price:</span>
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filter === f.value ? 'default' : 'outline'}
            onClick={() => { setFilter(f.value); setLoading(true); }}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Gainers */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-success" /> Top Gainers
            </CardTitle>
            <Badge className="bg-success text-success-foreground">{gainers.length}</Badge>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : gainers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No gainers data. Start the data saver to collect ticks.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">LTP</TableHead>
                    <TableHead className="text-right">Change (₹)</TableHead>
                    <TableHead className="text-right">Change %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gainers.map((g) => (
                    <TableRow key={g._id}>
                      <TableCell className="font-medium">{g._id}</TableCell>
                      <TableCell className="text-right font-mono">₹{fmtNum(g.ltp)}</TableCell>
                      <TableCell className="text-right font-mono text-success font-medium">+₹{fmtNum(g.priceChange)}</TableCell>
                      <TableCell className="text-right font-mono text-success">+{fmtNum(g.changePercent)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Losers */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingDown className="h-5 w-5 text-destructive" /> Top Losers
            </CardTitle>
            <Badge variant="destructive">{losers.length}</Badge>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : losers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No losers data. Start the data saver to collect ticks.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead className="text-right">LTP</TableHead>
                    <TableHead className="text-right">Change (₹)</TableHead>
                    <TableHead className="text-right">Change %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {losers.map((l) => (
                    <TableRow key={l._id}>
                      <TableCell className="font-medium">{l._id}</TableCell>
                      <TableCell className="text-right font-mono">₹{fmtNum(l.ltp)}</TableCell>
                      <TableCell className="text-right font-mono text-destructive font-medium">-₹{fmtNum(Math.abs(l.priceChange))}</TableCell>
                      <TableCell className="text-right font-mono text-destructive">{fmtNum(l.changePercent)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
