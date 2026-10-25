'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet, TrendingUp, TrendingDown, Percent as PercentIcon, Coins,
  Receipt, Plus, Minus, ArrowUpRight, ArrowDownRight, Activity,
  BarChart3, History, Zap, Target, Shield, CircleDollarSign,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MetricCard, SectionCard, LiveIndicator } from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { DummyThemedPage, DummyBadge, VirtualFundsNote } from '@/components/dummy/ui';
import { useToast } from '@/hooks/use-toast';
import { addDemoFunds, withdrawDemoFunds, resetDemoAccount, getDemoDailyReport } from '@/lib/api';
import { formatISTDateTime, istDateKey } from '@/lib/ist';
import { FundsHistory } from '@/components/account/funds-history';
import { useAccountData } from '@/lib/account-service';
import { getDailyReport, type DailyReport } from '@/lib/account-service';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { pnlClr, fmtPnl, fmtRs } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';

function fmtCoins(v: number | null | undefined): string {
  return `${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Coins`;
}

type DailyPnlEntry = {
  date: string;
  label: string;
  netPnl: number;
  grossPnl: number;
  charges: number;
  orders: number;
  closed: number;
};

function DailyPnlChart({ data }: { data: DailyPnlEntry[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No P&L history yet — trades will populate this chart
      </div>
    );
  }
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.netPnl)), 1);
  return (
    <div className="h-[200px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <defs>
            <linearGradient id="pnlGradientPos" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="pnlGradientNeg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--destructive))" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(var(--destructive))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false}
            tickLine={false}
            width={50}
            tickFormatter={(v: number) => `₹${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '12px',
              fontSize: '12px',
            }}
            formatter={(value: number, name: string) => [
              name === 'netPnl' ? fmtPnl(value) : fmtRs(value),
              name === 'netPnl' ? 'Net P&L' : 'Charges',
            ]}
            labelFormatter={(label: string) => `Date: ${label}`}
          />
          <Area
            type="monotone"
            dataKey="netPnl"
            stroke="hsl(var(--success))"
            strokeWidth={2}
            fill="url(#pnlGradientPos)"
            dot={{ r: 3, fill: 'hsl(var(--success))' }}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function DummyAccount() {
  const { state, error, refresh } = useDummyState(2000);
  const { latest, connected, lastMessageAt } = useLatestTicks(true);
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<null | 'add' | 'withdraw' | 'reset'>(null);
  const [dailyDate, setDailyDate] = useState(() => istDateKey());
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [weeklyPnl, setWeeklyPnl] = useState<DailyPnlEntry[]>([]);
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const { funds, history, refresh: refreshLedger } = useAccountData(10000);

  const refreshDaily = useCallback(async (d: string) => {
    setDailyLoading(true);
    try {
      const r = await getDailyReport(d);
      setDailyReport(r);
    } catch {
      setDailyReport(null);
    } finally {
      setDailyLoading(false);
    }
  }, []);

  const refreshWeeklyPnl = useCallback(async () => {
    setWeeklyLoading(true);
    try {
      const days: DailyPnlEntry[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        try {
          const r = await getDemoDailyReport(dateStr);
          if (r && r.stat !== 'NotOk') {
            days.push({
              date: dateStr,
              label: d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }),
              netPnl: r.netRealizedPnl ?? 0,
              grossPnl: r.grossRealizedPnl ?? 0,
              charges: r.totalCharges ?? 0,
              orders: r.orders ?? 0,
              closed: r.closedPositions ?? 0,
            });
          }
        } catch { /* skip missing days */ }
      }
      setWeeklyPnl(days);
    } catch { /* keep empty */ } finally {
      setWeeklyLoading(false);
    }
  }, []);

  useEffect(() => { void refreshDaily(dailyDate); }, [dailyDate, refreshDaily, state?.account?.balance]);
  useEffect(() => { if (state?.account) void refreshDaily(dailyDate); }, [state?.account?.realizedPnl, state?.account?.totalCharges]);
  useEffect(() => { void refreshWeeklyPnl(); }, [refreshWeeklyPnl, state?.account?.realizedPnl]);

  const runFundAction = async (kind: 'add' | 'withdraw') => {
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      toast({ variant: 'destructive', title: 'Enter an amount', description: 'Amount must be positive.' });
      return;
    }
    setBusy(kind);
    try {
      if (kind === 'add') await addDemoFunds(amt);
      else await withdrawDemoFunds(amt);
      toast({ title: kind === 'add' ? 'Deposit done' : 'Withdrawal done', description: `${fmtCoins(amt)} applied.` });
      setAmount('');
      await refresh();
      await refreshLedger();
      void refreshDaily(dailyDate);
      void refreshWeeklyPnl();
    } catch (err: any) {
      toast({ variant: 'destructive', title: kind === 'add' ? 'Deposit failed' : 'Withdrawal failed', description: err?.detail ?? err?.message });
    } finally {
      setBusy(null);
    }
  };

  const runReset = async () => {
    if (!window.confirm('Reset the Dummy account to its starting balance? All orders, positions and history will be cleared.')) return;
    setBusy('reset');
    try {
      await resetDemoAccount(100000);
      toast({ title: 'Account reset', description: 'Dummy account restored to 100,000 Coins.' });
      await refresh();
      await refreshLedger();
      void refreshDaily(dailyDate);
      void refreshWeeklyPnl();
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Reset failed', description: err?.detail ?? err?.message });
    } finally {
      setBusy(null);
    }
  };

  const positions = useMemo(() => (state?.positions || []).filter((p) => p.netQuantity !== 0), [state?.positions]);
  const account = state?.account;
  const liveUnreal = useMemo(
    () => positions.reduce((sum, p) => sum + Number(p.unrealizedPnl || 0), 0),
    [positions],
  );
  const gross = Number(account?.realizedPnl ?? 0) + liveUnreal;
  const netToday = dailyReport ? dailyReport.netRealizedPnl : (Number(account?.realizedPnl ?? 0) - Number(account?.totalCharges ?? 0));
  const equity = Number(account?.balance ?? 0) + Number(account?.realizedPnl ?? 0) + liveUnreal;
  const totalPnl = gross - Number(account?.totalCharges ?? 0);
  const marginUtilPct = account?.balance && Number(account.balance) > 0
    ? (Number(account.usedMargin || 0) / Number(account.balance)) * 100
    : 0;
  const streamLive = connected && lastMessageAt != null && Date.now() - lastMessageAt < 20000;

  const todayClosed = useMemo(() => (state?.positions || []).filter((p) => p.netQuantity === 0).length, [state?.positions]);

  return (
    <DummyThemedPage className="mx-auto w-full max-w-6xl space-y-5 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Account</h1>
          <p className="text-sm text-muted-foreground">Live balance · margin · P&L · charges · ledger</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <LiveIndicator live={streamLive} label={streamLive ? 'Live' : 'Offline'} />
          <DummyBadge />
          <VirtualFundsNote />
        </div>
      </div>

      {error && !state ? <div className="text-sm text-destructive">{error}</div> : null}

      {/* Summary Cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          icon={Coins}
          tone="teal"
          title="Equity"
          value={fmtCoins(equity)}
          sub={`Cash ${fmtCoins(account?.balance)}`}
        />
        <MetricCard
          icon={Wallet}
          tone="success"
          title="Available"
          value={fmtCoins(account?.freeMargin)}
          sub="Withdrawable"
        />
        <MetricCard
          icon={PercentIcon}
          tone={marginUtilPct > 70 ? 'danger' : marginUtilPct > 40 ? 'warning' : 'neutral'}
          title="Used Margin"
          value={fmtCoins(account?.usedMargin)}
          sub={`Util ${marginUtilPct.toFixed(1)}%`}
        />
        <MetricCard
          icon={totalPnl >= 0 ? TrendingUp : TrendingDown}
          tone={totalPnl >= 0 ? 'success' : 'danger'}
          title="Net P&L"
          value={fmtPnl(totalPnl)}
          sub={dailyReport ? `Gross ${fmtPnl(dailyReport.grossRealizedPnl)}` : `Gross ${fmtPnl(gross)}`}
          valueClass={pnlClr(totalPnl)}
        />
        <MetricCard
          icon={Receipt}
          tone={Number(account?.totalCharges || 0) > 0 ? 'warning' : 'neutral'}
          title="Charges"
          value={fmtCoins(account?.totalCharges)}
          sub={`Orders ${account?.dailyOrders ?? 0} · Pos ${positions.length}`}
          valueClass={Number(account?.totalCharges || 0) > 0 ? 'text-destructive' : undefined}
        />
        <MetricCard
          icon={Activity}
          tone={liveUnreal >= 0 ? 'success' : 'danger'}
          title="Unrealized"
          value={fmtPnl(liveUnreal)}
          sub={streamLive ? 'Live from positions' : 'From last tick'}
          valueClass={pnlClr(liveUnreal)}
        />
      </div>

      {/* Sub-strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-border/40 bg-muted/20 px-4 py-2.5 text-xs tabular-nums">
        <span className="text-muted-foreground">
          Realized <span className={cn('font-bold', pnlClr(account?.realizedPnl))}>{fmtPnl(account?.realizedPnl)}</span>
        </span>
        <span className="hidden text-muted-foreground/30 sm:inline">|</span>
        <span className="text-muted-foreground">
          Open Positions <span className="font-bold text-foreground">{positions.length}</span>
        </span>
        <span className="hidden text-muted-foreground/30 sm:inline">|</span>
        <span className="text-muted-foreground">
          Today Closed <span className="font-bold text-foreground">{todayClosed}</span>
        </span>
        <span className="hidden text-muted-foreground/30 sm:inline">|</span>
        <span className="text-muted-foreground">
          Today Orders <span className="font-bold text-foreground">{dailyReport?.orders ?? account?.dailyOrders ?? '—'}</span>
        </span>
        <span className="hidden text-muted-foreground/30 sm:inline">|</span>
        <span className="text-muted-foreground">
          Session <span className="font-bold text-foreground">{state?.session?.today_pnl != null ? fmtPnl(state.session.today_pnl) : '—'}</span>
        </span>
      </div>

      {/* Move Funds */}
      <SectionCard title="Move Funds" icon={CircleDollarSign}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">Amount (Coins)</div>
            <Input type="number" min={1} placeholder="Enter amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-44" />
          </div>
          <Button disabled={busy !== null} onClick={() => void runFundAction('add')} className="rounded-xl">
            <Plus className="mr-1.5 h-4 w-4" />{busy === 'add' ? 'Adding…' : 'Add Funds'}
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void runFundAction('withdraw')} className="rounded-xl">
            <Minus className="mr-1.5 h-4 w-4" />{busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void runReset()} className="rounded-xl text-xs">
            {busy === 'reset' ? 'Resetting…' : 'Reset to 100,000'}
          </Button>
          <span className="text-xs text-muted-foreground">Withdrawable: <span className="font-semibold text-foreground">{fmtCoins(account?.freeMargin)}</span></span>
        </div>
      </SectionCard>

      {/* Daily P&L Chart */}
      <SectionCard
        title="P&L History"
        icon={BarChart3}
        headerRight={
          <span className="text-[10px] text-muted-foreground">Last 7 trading days</span>
        }
      >
        {weeklyLoading ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">Loading chart…</div>
        ) : (
          <>
            <DailyPnlChart data={weeklyPnl} />
            {weeklyPnl.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-muted/30 p-3 text-center">
                  <div className="text-lg font-bold tabular-nums text-success">
                    {fmtPnl(weeklyPnl.filter((d) => d.netPnl > 0).reduce((s, d) => s + d.netPnl, 0))}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Best Week</div>
                </div>
                <div className="rounded-xl bg-muted/30 p-3 text-center">
                  <div className="text-lg font-bold tabular-nums text-destructive">
                    {fmtPnl(weeklyPnl.filter((d) => d.netPnl < 0).reduce((s, d) => s + d.netPnl, 0))}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Worst Loss</div>
                </div>
                <div className="rounded-xl bg-muted/30 p-3 text-center">
                  <div className="text-lg font-bold tabular-nums">
                    {weeklyPnl.length > 0 ? fmtPnl(weeklyPnl.reduce((s, d) => s + d.netPnl, 0) / weeklyPnl.length) : '—'}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Avg/Day</div>
                </div>
                <div className="rounded-xl bg-muted/30 p-3 text-center">
                  <div className="text-lg font-bold tabular-nums text-success">
                    {weeklyPnl.filter((d) => d.netPnl > 0).length}/{weeklyPnl.length}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Win Days</div>
                </div>
              </div>
            )}
          </>
        )}
      </SectionCard>

      {/* Daily Report */}
      <SectionCard
        title="Daily Report"
        icon={History}
        headerRight={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 w-7 p-0 rounded-lg" onClick={() => { const d = new Date(dailyDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); setDailyDate(d.toISOString().slice(0, 10)); }}>&lt;</Button>
            <span className="rounded-lg border border-border/40 bg-muted/20 px-2.5 py-1 font-mono text-xs tabular-nums">
              {new Date(dailyDate + 'T00:00:00').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}
            </span>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0 rounded-lg" onClick={() => { const d = new Date(dailyDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); const iso = d.toISOString().slice(0, 10); if (iso <= istDateKey()) setDailyDate(iso); }} disabled={dailyDate === istDateKey()}>&gt;</Button>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs rounded-lg" onClick={() => setDailyDate(istDateKey())}>Today</Button>
          </div>
        }
      >
        {dailyLoading ? (
          <div className="py-4 text-center text-sm text-muted-foreground">Loading daily report…</div>
        ) : !dailyReport ? (
          <div className="py-4 text-center text-sm text-muted-foreground">No account activity for this date.</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-1.5 divide-y divide-border/30 rounded-xl border border-border/40 p-4">
              <div className="flex justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">Opening Balance</span>
                <span className="font-mono font-semibold tabular-nums">{fmtCoins(dailyReport.openingBalance)}</span>
              </div>
              <div className="flex justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">Deposits</span>
                <span className="font-mono font-semibold tabular-nums text-success">+{fmtCoins(dailyReport.deposits)}</span>
              </div>
              <div className="flex justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">Withdrawals</span>
                <span className="font-mono font-semibold tabular-nums text-destructive">-{fmtCoins(dailyReport.withdrawals)}</span>
              </div>
              <div className="flex justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">Gross Realized P&L</span>
                <span className={cn('font-mono font-semibold tabular-nums', pnlClr(dailyReport.grossRealizedPnl))}>{fmtPnl(dailyReport.grossRealizedPnl)}</span>
              </div>
              <div className="flex justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">Total Charges</span>
                <span className="font-mono font-semibold tabular-nums text-destructive">-{fmtCoins(dailyReport.totalCharges)}</span>
              </div>
              <div className="flex justify-between border-t border-border/50 py-2 text-sm font-bold">
                <span>Net Realized P&L</span>
                <span className={pnlClr(dailyReport.netRealizedPnl)}>{fmtPnl(dailyReport.netRealizedPnl)}</span>
              </div>
              <div className="flex justify-between py-1.5 text-sm">
                <span className="text-muted-foreground">Closing Equity</span>
                <span className="font-mono font-semibold tabular-nums">{fmtCoins(dailyReport.closingEquity)}</span>
              </div>
              <div className="pt-2 text-[11px] text-muted-foreground">
                Peak / Lowest equity: {dailyReport.peakEquity == null ? 'Not available' : `${fmtCoins(dailyReport.peakEquity)} / ${fmtCoins(dailyReport.lowestEquity)}`}
              </div>
            </div>
            <div className="rounded-xl border border-border/40 p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trading Activity</div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-muted/30 p-3">
                  <div className="text-xl font-bold tabular-nums">{dailyReport.orders}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Orders</div>
                </div>
                <div className="rounded-xl bg-success/10 p-3">
                  <div className="text-xl font-bold tabular-nums text-success">{dailyReport.filledOrders}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Filled</div>
                </div>
                <div className="rounded-xl bg-destructive/10 p-3">
                  <div className="text-xl font-bold tabular-nums text-destructive">{dailyReport.rejectedOrders}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Rejected</div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl bg-muted/30 p-3">
                  <div className="text-xl font-bold tabular-nums">{dailyReport.openPositions}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Open Pos</div>
                </div>
                <div className="rounded-xl bg-teal/10 p-3">
                  <div className="text-xl font-bold tabular-nums">{dailyReport.closedPositions}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Closed</div>
                </div>
                <div className="rounded-xl bg-muted/30 p-3">
                  <div className="text-xl font-bold tabular-nums">{dailyReport.cancelledOrders}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cancelled</div>
                </div>
              </div>
              <div className="mt-3 rounded-xl bg-muted/20 p-3 text-[11px] text-muted-foreground">
                Unrealized today: <span className="font-semibold text-foreground">{fmtPnl(dailyReport.unrealizedPnl)}</span>
                {' · '}Opening equity {fmtCoins(dailyReport.openingEquity)}
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Risk Overview */}
      <SectionCard title="Risk Overview" icon={Shield}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Target className="h-3 w-3" /> Exposure
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">{fmtCoins(state?.risk?.exposure ?? 0)}</div>
            <div className="text-[10px] text-muted-foreground">Invested in positions</div>
          </div>
          <div className="rounded-xl bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Zap className="h-3 w-3" /> Margin Util
            </div>
            <div className={cn('mt-1 text-lg font-bold tabular-nums', marginUtilPct > 70 ? 'text-destructive' : marginUtilPct > 40 ? 'text-warning' : 'text-success')}>
              {marginUtilPct.toFixed(1)}%
            </div>
            <div className="text-[10px] text-muted-foreground">Of total balance</div>
          </div>
          <div className="rounded-xl bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Activity className="h-3 w-3" /> Active Alerts
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">{state?.risk?.activeAlerts ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">Price alerts armed</div>
          </div>
          <div className="rounded-xl bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Target className="h-3 w-3" /> Pending Targets
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums">{state?.risk?.pendingTargets ?? 0}</div>
            <div className="text-[10px] text-muted-foreground">Profit/loss targets</div>
          </div>
        </div>
      </SectionCard>

      {/* Transaction History */}
      <FundsHistory transactions={history as any} source="demo-engine" loading={false} />
    </DummyThemedPage>
  );
}
