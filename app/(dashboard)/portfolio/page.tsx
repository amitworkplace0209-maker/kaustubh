'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  TrendingUp, TrendingDown, Wallet, Target, Percent, IndianRupee,
  RefreshCw, Calendar, BarChart3, Trophy, Activity,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { getTradingDayStats, getTradingHistory } from '@/lib/api';

function safeNum(n: any): number {
  const v = Number(n);
  return isNaN(v) ? 0 : v;
}

function fmtINR(n: number): string {
  return `₹${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PortfolioPage() {
  const [dayStats, setDayStats] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState('daily');
  const [selectedDate, setSelectedDate] = useState('');

  const fetch = useCallback(async () => {
    try {
      const [statsRes, histRes] = await Promise.allSettled([
        getTradingDayStats(selectedDate || undefined),
        getTradingHistory(range, 30),
      ]);
      if (statsRes.status === 'fulfilled') setDayStats(statsRes.value);
      if (histRes.status === 'fulfilled') setHistory(histRes.value.data || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [selectedDate, range]);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 10000);
    return () => clearInterval(interval);
  }, [fetch]);

  const chartData = useMemo(() => {
    if (!history || history.length === 0) return [];
    return history.map((h) => {
      if (range === 'daily') {
        return {
          label: h.date?.slice(5) || '—',
          pnl: safeNum(h.totalWrites),
          trades: safeNum(h.totalTicks),
          errors: safeNum(h.errorCount),
        };
      }
      const id = h._id || {};
      const label = range === 'yearly'
        ? `${id.year}`
        : range === 'monthly'
          ? `${id.year}-${String(id.month).padStart(2, '0')}`
          : `${id.year}-W${id.week}`;
      return { label, pnl: safeNum(h.totalWrites), trades: safeNum(h.totalTicks), errors: safeNum(h.errorCount) };
    });
  }, [history, range]);

  const s = dayStats || {};
  const todayPnl = safeNum(s.todayPnl);
  const todayTrades = safeNum(s.todayTrades);
  const todayWins = safeNum(s.todayWins);
  const todayLosses = safeNum(s.todayLosses);
  const todayWinRate = safeNum(s.todayWinRate);
  const todayLossRate = safeNum(s.todayLossRate);
  const todayCharges = safeNum(s.todayCharges);
  const todayNetProfit = safeNum(s.todayNetProfit);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Portfolio Analytics</h1>
          <p className="text-sm text-muted-foreground">Intraday trading performance and historical statistics</p>
        </div>
        <div className="flex gap-2">
          <Select value={selectedDate} onValueChange={setSelectedDate}>
            <SelectTrigger className="w-40"><Calendar className="h-4 w-4 mr-2" /><SelectValue placeholder="Today" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Today</SelectItem>
              {history.filter((h) => h.date).slice(0, 30).map((h) => (
                <SelectItem key={h.date} value={h.date}>{h.date}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={fetch}><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* Today's Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className={todayPnl >= 0 ? 'card-accent-green' : 'card-accent-red'}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Today's P&L</CardTitle>
            {todayPnl >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <TrendingDown className="h-4 w-4 text-destructive" />}
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${todayPnl >= 0 ? 'text-success' : 'text-destructive'}`}>{fmtINR(todayPnl)}</div>
          </CardContent>
        </Card>
        <Card className="card-accent-teal">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Today's Trades</CardTitle>
            <Activity className="h-4 w-4 text-teal-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{todayTrades}</div>
            <p className="text-xs text-muted-foreground">{todayWins} wins · {todayLosses} losses</p>
          </CardContent>
        </Card>
        <Card className="card-accent-amber">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Win Rate</CardTitle>
            <Trophy className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">{todayWinRate}%</div>
            <p className="text-xs text-muted-foreground">Loss rate: {todayLossRate}%</p>
          </CardContent>
        </Card>
        <Card className="card-accent-purple">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Net Profit</CardTitle>
            <Wallet className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${todayNetProfit >= 0 ? 'text-success' : 'text-destructive'}`}>{fmtINR(todayNetProfit)}</div>
            <p className="text-xs text-muted-foreground">Charges: {fmtINR(todayCharges)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Range Selector */}
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-muted-foreground" />
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="yearly">Yearly</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">P&L Trend ({range})</CardTitle></CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">No historical data available</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(160 84% 45%)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(160 84% 45%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }} />
                  <Area type="monotone" dataKey="pnl" stroke="hsl(160 84% 45%)" fill="url(#pnlGrad)" name="P&L" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Trades & Errors ({range})</CardTitle></CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">No historical data available</p>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px' }} />
                  <Legend />
                  <Bar dataKey="trades" fill="hsl(200 80% 50%)" name="Trades" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="errors" fill="hsl(0 72% 50%)" name="Errors" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Historical Data Table */}
      <Card>
        <CardHeader><CardTitle className="text-base">Historical Records</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  <th className="p-3 text-left font-medium">Date/Period</th>
                  <th className="p-3 text-right font-medium">Total Ticks</th>
                  <th className="p-3 text-right font-medium">Total Writes</th>
                  <th className="p-3 text-right font-medium">Errors</th>
                  <th className="p-3 text-right font-medium">Reconnects</th>
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No historical data</td></tr>
                ) : (
                  history.slice().reverse().map((h, i) => {
                    const label = h.date || (h._id ? `${h._id.year ?? ''}${h._id.month ? '-' + String(h._id.month).padStart(2, '0') : ''}${h._id.week ? '-W' + h._id.week : ''}` : '—');
                    return (
                      <tr key={i} className="border-b hover:bg-muted/50 transition-colors text-sm">
                        <td className="p-3 font-medium">{label}</td>
                        <td className="p-3 text-right">{safeNum(h.totalTicks).toLocaleString()}</td>
                        <td className="p-3 text-right text-success">{safeNum(h.totalWrites).toLocaleString()}</td>
                        <td className="p-3 text-right">{safeNum(h.errorCount)}</td>
                        <td className="p-3 text-right">{safeNum(h.reconnectCount)}</td>
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
