'use client';

import { useCallback, useEffect, useState } from 'react';
import { Wallet, TrendingUp, Receipt, CalendarDays } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { MetricCard, EmptyState, ErrorState, SectionCard } from '@/components/design-system';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDummyState } from '@/hooks/use-dummy-state';
import { getDummyPortfolio, getDummyReports, equityLabel } from '@/lib/dummy';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { cn } from '@/lib/utils';

type Range = 'daily' | 'weekly' | 'monthly';

type HistoryPoint = { equity: number; balance: number; realized: number; ts: string; label: string };

function fmtAxis(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(0)}k`;
  return String(Math.round(v));
}

function fmtRs(v: number): string {
  return Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function DummyPortfolio() {
  const { state, error, refresh } = useDummyState(5000);
  const [range, setRange] = useState<Range>('daily');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  const loadReports = useCallback(async (r: Range) => {
    setLoading(true);
    try {
      const res = await getDummyReports(r, r === 'daily' ? 60 : 26);
      setRows(Array.isArray(res?.rows) ? res.rows : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadReports(range); }, [loadReports, range, state?.account?.dailyOrders]);

  useEffect(() => {
    getDummyPortfolio()
      .then((res) => {
        const pts: HistoryPoint[] = ((res?.history || []) as any[])
          .slice()
          .sort((a: any, b: any) => (String(a.date || a.ts) < String(b.date || b.ts) ? -1 : 1))
          .map((h: any) => ({
            equity: Number(h.equity ?? h.balance ?? 0) + Number(h.unrealizedPnl ?? 0),
            balance: Number(h.balance ?? 0),
            realized: Number(h.realizedPnl ?? 0),
            ts: h.ts || h.date || '',
            label: String(h.date || h.tradingDate || (h.ts || '').slice(0, 10)),
          }));
        setHistory(pts);
      })
      .catch(() => {});
  }, [state?.account?.dailyOrders]);

  if (error && !state) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  const account = state?.account;
  const equity = account ? account.balance + account.unrealizedPnl : 0;
  const totalPnl = account?.totalPnl ?? 0;
  const periodLabel = range === 'daily' ? 'Date' : 'Period';

  return (
    <DummyThemedPage>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Portfolio</h1>
          <DummyBadge />
        </div>
        <p className="text-[11px] text-muted-foreground">Day resets 12:00 AM IST · every day saved in database</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard icon={Wallet} title="Total equity" value={equityLabel(equity)} tone={equity >= (account?.balance ?? 0) ? 'success' : 'neutral'} />
        <MetricCard icon={Wallet} title="Balance" value={equityLabel(account?.balance)} tone="neutral" />
        <MetricCard icon={TrendingUp} title="Total P&L" value={equityLabel(totalPnl)} tone={totalPnl >= 0 ? 'success' : 'danger'} />
        <MetricCard icon={Receipt} title="Charges (today)" value={equityLabel(account?.totalCharges)} tone="warning" />
      </div>

      <SectionCard title="P&L Report — every day, saved in database" icon={CalendarDays}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(['daily', 'weekly', 'monthly'] as Range[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'default' : 'outline'}
              onClick={() => setRange(r)}
              className="capitalize"
            >
              {r === 'daily' ? 'Daily' : r === 'weekly' ? 'Weekly' : 'Monthly'}
            </Button>
          ))}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {range === 'daily' ? 'Har din: P&L · orders · charges' : range === 'weekly' ? 'Har week ka report' : 'Har month ka report'}
          </span>
        </div>

        {loadError && <p className="mb-2 text-sm text-red-500">{loadError}</p>}

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading report…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No report rows yet"
            description="Trade in Dummy mode — har din ka P&L, orders aur charges yahan save honge."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="p-2 text-left font-medium">{periodLabel}</th>
                  {range === 'daily' ? (
                    <th className="p-2 text-left font-medium">Status</th>
                  ) : (
                    <th className="p-2 text-right font-medium">Days</th>
                  )}
                  <th className="p-2 text-right font-medium">P&L</th>
                  <th className="p-2 text-right font-medium">Charges</th>
                  <th className="p-2 text-right font-medium">Net</th>
                  <th className="p-2 text-right font-medium">Orders</th>
                  <th className="p-2 text-right font-medium">Filled</th>
                  {range === 'daily' && <th className="p-2 text-right font-medium">Turnover</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any, i: number) => (
                  <tr key={`${r.date || r.key}-${i}`} className="border-b">
                    <td className="p-2 font-medium">{range === 'daily' ? r.date : (r.label || r.key)}</td>
                    {range === 'daily' ? (
                      <td className="p-2">
                        <Badge variant={r.status === 'LIVE' ? 'default' : 'outline'} className="text-[10px]">
                          {r.status === 'LIVE' ? 'Today · live' : 'Closed'}
                        </Badge>
                      </td>
                    ) : (
                      <td className="p-2 text-right tabular-nums">{r.days}</td>
                    )}
                    <td className={cn('p-2 text-right tabular-nums font-medium', (r.realizedPnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                      {fmtRs(r.realizedPnl)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{fmtRs(r.charges)}</td>
                    <td className={cn('p-2 text-right tabular-nums font-bold', (r.netPnl ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                      {fmtRs(r.netPnl)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{r.orders}</td>
                    <td className="p-2 text-right tabular-nums">{r.filled}</td>
                    {range === 'daily' && <td className="p-2 text-right tabular-nums">{fmtRs(r.turnover)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Equity curve (daily snapshots, IST dates)" icon={TrendingUp}>
        {history.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No history yet"
            description="The equity curve grows as you trade; snapshots are taken per IST calendar day."
          />
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--dummy-accent, #10b981)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--dummy-accent, #10b981)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                  formatter={(value: any) => [Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 }), 'Equity']}
                />
                <Area type="monotone" dataKey="equity" stroke="var(--dummy-accent, #10b981)" strokeWidth={2} fill="url(#equityFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </SectionCard>
    </DummyThemedPage>
  );
}
