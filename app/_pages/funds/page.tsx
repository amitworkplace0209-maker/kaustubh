'use client';

import { istDateKey } from '@/lib/ist';

/** Pure date-key arithmetic on a 'YYYY-MM-DD' value, free of any timezone drift. */
function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- Account page (funds) ----
//
// Data flows through ONE service layer (lib/account-service.ts) and ONE
// refresh manager (useAccountData). Cards never fetch on their own.
//
//   API MODE : real Kotak Neo RMS limits only — missing broker fields render
//              as N/A, explicit zeros render as ₹0.00, history shows an honest
//              "not available from broker" state.
//   DEMO MODE: demo-engine virtual account + its real transaction ledger.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Blocks, CheckCircle2,
  Gauge, IndianRupee, Landmark, Layers, LogIn, PiggyBank,
  RefreshCw, ShieldAlert, Wallet, Calendar, TrendingUp, Receipt, Coins,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { MetricCard } from '@/components/design-system';
import { cn } from '@/lib/utils';
import { useAccountMode, type AccountMode } from '@/lib/settings-store';
import { MAX_DEMO_TRANSACTION_AMOUNT } from '@/lib/demo-engine';
import { TradingService } from '@/lib/trading-service';
import { triggerLogin } from '@/lib/api';
import { fmtPnl, fmtRs } from '@/lib/formatters';
import { useToast } from '@/hooks/use-toast';
import {
  useAccountData, type AccountFunds, getDailyReport, type DailyReport,
} from '@/lib/account-service';
import { LiveStatus } from '@/components/account/live-status';
import { RefreshButton } from '@/components/account/refresh-button';
import { AccountHealthCard } from '@/components/account/account-health-card';
import { MarginUtilisation } from '@/components/account/margin-utilisation';
import { FundsHistory } from '@/components/account/funds-history';
import { useDummyState } from '@/hooks/use-dummy-state';

// ---------------- demo manage funds ----------------

function ManageDemoFunds({ withdrawable, onChanged }: { withdrawable: number; onChanged?: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const validate = (): number | null => {
    const raw = amount.trim();
    if (!raw) {
      setError('Enter an amount to continue.');
      return null;
    }
    const amt = Number(raw);
    if (!Number.isFinite(amt)) {
      setError('Amount must be a valid number.');
      return null;
    }
    if (amt <= 0) {
      setError('Amount must be greater than zero.');
      return null;
    }
    if (amt > MAX_DEMO_TRANSACTION_AMOUNT) {
      setError(`Maximum per transaction is \u20B9${MAX_DEMO_TRANSACTION_AMOUNT.toLocaleString('en-IN')}.`);
      return null;
    }
    return Math.round(amt * 100) / 100;
  };

  const run = async (kind: 'add' | 'withdraw') => {
    setError(null);
    setSuccess(null);
    const amt = validate();
    if (amt == null) return;
    setBusy(true);
    try {
      if (kind === 'add') await TradingService.addFunds(amt);
      else await TradingService.withdrawFunds(amt);
      setSuccess(`${fmtRs(amt)} ${kind === 'add' ? 'added to' : 'withdrawn from'} your demo balance.`);
      toast({
        title: kind === 'add' ? 'Funds added' : 'Funds withdrawn',
        description: `${fmtRs(amt)} ${kind === 'add' ? 'added to' : 'withdrawn from'} demo balance`,
      });
      setAmount('');
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to ${kind} funds`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        Manage Demo Funds
      </h2>
      <div className="rounded-xl border border-border/50 bg-card p-4 shadow-soft">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Amount (₹)</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="Enter amount"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError(null);
                setSuccess(null);
              }}
              aria-invalid={Boolean(error)}
              className="max-w-xs w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20 aria-invalid:border-destructive/60"
            />
            {error ? (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <ShieldAlert className="h-3.5 w-3.5" /> {error}
              </p>
            ) : success ? (
              <p className="flex items-center gap-1.5 text-xs text-success">
                <CheckCircle2 className="h-3.5 w-3.5" /> {success}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Withdrawable now: {fmtRs(Math.max(0, withdrawable))}
              </p>
            )}
          </div>
          <div className="flex max-w-md flex-col gap-3 sm:flex-row">
            <Button
              className="flex-1 bg-success hover:bg-success/90 text-success-foreground"
              onClick={() => run('add')}
              disabled={busy}
            >
              <ArrowDownToLine className="mr-2 h-4 w-4" /> Add Funds
            </Button>
            <Button variant="outline" className="flex-1" onClick={() => run('withdraw')} disabled={busy}>
              <ArrowUpFromLine className="mr-2 h-4 w-4" /> Withdraw Funds
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------- summary grid — compact 5 per spec ----------------

function SummaryGrid({
  funds, loading, stale, daily, account, positionsCount,
}: {
  funds: AccountFunds | null; loading: boolean; stale: boolean;
  daily?: import('@/lib/account-service').DailyReport | null;
  account?: { realizedPnl?: number; unrealizedPnl?: number; totalCharges?: number; dailyOrders?: number } | null;
  positionsCount?: number;
}) {
  const d = funds?.derivedFields ?? [];
  const srcLabel = funds?.source === 'demo-engine' ? 'Demo engine' : 'Kotak RMS';
  // Equity for dummy = balance + realized + unrealized (real P&L); for Kotak RMS use totalBalance as equity proxy
  const equity = funds?.totalBalance != null ? funds.totalBalance : null;
  const netPnl = daily?.netRealizedPnl ?? (account ? Number(account.realizedPnl ?? 0) - Number(account.totalCharges ?? 0) : null);
  const charges = daily?.totalCharges ?? account?.totalCharges ?? funds?.totalBalance == null ? null : null;
  // Fallback to account charges when daily not available
  const totalChargesVal = daily?.totalCharges ?? account?.totalCharges ?? null;
  const realizedVal = daily?.grossRealizedPnl ?? account?.realizedPnl ?? null;
  const unrealizedVal = daily?.unrealizedPnl ?? account?.unrealizedPnl ?? null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          icon={Wallet}
          tone="teal"
          title="Balance / Equity"
          value={funds ? fmtRs(equity) : null}
          sub={funds ? srcLabel : undefined}
          loading={loading && !funds}
          stale={stale}
        />
        <MetricCard
          icon={PiggyBank}
          tone="success"
          title="Available Margin"
          value={funds ? fmtRs(funds.availableMargin) : null}
          sub={funds ? srcLabel : undefined}
          loading={loading && !funds}
          stale={stale}
        />
        <MetricCard
          icon={Gauge}
          tone="warning"
          title="Used Margin"
          value={funds ? fmtRs(funds.utilisedMargin) : null}
          sub={funds ? `Util ${funds.marginUtilisation?.toFixed(1) ?? '—'}%` : undefined}
          loading={loading && !funds}
          stale={stale}
        />
        <MetricCard
          icon={totalChargesVal != null && Number(netPnl) >= 0 ? Wallet : Wallet}
          tone={netPnl == null ? 'neutral' : Number(netPnl) >= 0 ? 'success' : 'danger'}
          title="Today's Net P&L"
          value={netPnl == null ? null : `${Number(netPnl) >= 0 ? '+' : ''}${fmtRs(Math.abs(Number(netPnl)))}`.replace('₹','₹')}
          sub={daily ? `Deposits ${fmtRs(daily.deposits)} · W/D ${fmtRs(daily.withdrawals)}` : account ? `Real ${fmtRs(realizedVal)} · Unrl ${fmtRs(unrealizedVal)}` : undefined}
          valueClass={netPnl == null ? undefined : Number(netPnl) >= 0 ? 'text-success' : 'text-destructive'}
          loading={loading && !funds}
          stale={stale}
        />
        <MetricCard
          icon={IndianRupee}
          tone={totalChargesVal != null && totalChargesVal > 0 ? 'warning' : 'neutral'}
          title="Total Charges"
          value={totalChargesVal == null ? null : fmtRs(totalChargesVal)}
          sub={daily ? `Gross ${fmtRs(daily.grossRealizedPnl)}` : account ? `Orders ${account.dailyOrders ?? '—'}` : undefined}
          loading={loading && !funds}
          stale={stale}
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[11px] tabular-nums">
        <span className="text-muted-foreground">Realized <span className="font-semibold text-foreground">{realizedVal == null ? '—' : fmtRs(realizedVal)}</span></span>
        <span className="hidden text-muted-foreground/40 sm:inline">·</span>
        <span className="text-muted-foreground">Unrealized <span className="font-semibold text-foreground">{unrealizedVal == null ? '—' : fmtRs(unrealizedVal)}</span></span>
        <span className="hidden text-muted-foreground/40 sm:inline">·</span>
        <span className="text-muted-foreground">Today Orders <span className="font-semibold text-foreground">{daily?.orders ?? account?.dailyOrders ?? '—'}</span></span>
        <span className="hidden text-muted-foreground/40 sm:inline">·</span>
        <span className="text-muted-foreground">Open Positions <span className="font-semibold text-foreground">{positionsCount ?? daily?.openPositions ?? '—'}</span></span>
        {funds?.marginUtilisation != null && (
          <>
            <span className="hidden text-muted-foreground/40 sm:inline">·</span>
            <span className="text-muted-foreground">Util <span className={funds.marginUtilisation >= 80 ? 'text-destructive font-semibold' : funds.marginUtilisation >= 50 ? 'text-warning font-semibold' : 'font-semibold'}>{funds.marginUtilisation.toFixed(1)}%</span></span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- breakdown ----------------

function BreakdownRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/40 py-2 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
      </div>
      <span className="shrink-0 font-mono text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function FundsBreakdown({ funds }: { funds: AccountFunds | null }) {
  const known = (n: number | null | undefined): string =>
    n == null || !Number.isFinite(n) ? '\u2014' : fmtRs(n);
  return (
    <div className="divide-y divide-transparent">
      <BreakdownRow
        label="Total Funds"
        value={known(funds?.totalBalance)}
        note={funds?.derivedFields.includes('totalBalance')
          ? 'Available Margin + Utilised Margin'
          : 'As reported by the broker'}
      />
      <BreakdownRow
        label="Free Cash"
        value={known(funds?.cashComponent)}
        note="Unpledged cash component of your margin"
      />
      <BreakdownRow
        label="Collateral Pledge Value"
        value={known(funds?.collateralValue)}
        note="Pledged securities counted toward margin"
      />
      <BreakdownRow
        label="Withdrawable Now"
        value={known(funds?.withdrawableAmount)}
        note={funds?.withdrawableAmount != null
          ? (funds.derivedFields.includes('withdrawableAmount')
            ? 'Total minus utilised margin'
            : 'Settled funds available for withdrawal')
          : 'Broker did not report a withdrawable figure'}
      />
    </div>
  );
}

// ---------------- api info footer ----------------

function ApiInfoFooter({ mode, kotakConnected, lastSyncAt }: {
  mode: AccountMode;
  kotakConnected: boolean | null;
  lastSyncAt: number | null;
}) {
  const lastSync = lastSyncAt != null
    ? new Date(lastSyncAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
    : 'N/A';
  const rows: Array<[string, string]> = [
    ['Source', mode === 'demo' ? 'Demo engine (virtual)' : 'Kotak Neo RMS limits'],
    ['Connection', mode === 'demo'
      ? 'Local demo engine'
      : kotakConnected == null ? 'Unknown' : kotakConnected ? 'Connected' : 'Disconnected'],
    ['Last sync', lastSync],
  ];
  return (
    <section className="space-y-3">
      <h2 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        API Information
      </h2>
      <div className="grid gap-3 rounded-xl border border-border/50 bg-card p-4 shadow-soft sm:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{k}</div>
            <div
              className={cn(
                'mt-0.5 font-mono text-xs font-medium',
                k === 'Connection' && mode === 'api'
                  ? kotakConnected ? 'text-success' : 'text-destructive'
                  : '',
              )}
            >
              {v}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------- daily report ----------------

function DailyReportSection({ date, report, loading, onPrev, onNext, onToday }: {
  date: string; report: DailyReport | null; loading: boolean;
  onPrev: () => void; onNext: () => void; onToday: () => void;
}) {
  const isToday = (() => {
    try { const today = istDateKey(); return date === today; } catch { return false; }
  })();
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">Daily Report</h2>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={onPrev} aria-label="Previous day">‹</Button>
          <div className="flex items-center gap-1 rounded-md border border-border/40 bg-card px-2 py-1 text-xs">
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <input type="date" value={date} onChange={(e) => { const v=e.target.value; if(v) { onToday(); } }} className="bg-transparent text-xs outline-none" style={{display:'none'}} />
            <span className="font-mono text-xs font-medium tabular-nums">{new Date(date+'T00:00:00').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day:'2-digit',month:'short',year:'numeric' })}</span>
            <span className="hidden sm:inline text-[10px] text-muted-foreground">{isToday ? '· Today' : ''}</span>
          </div>
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={onNext} aria-label="Next day" disabled={isToday}>›</Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onToday}>Today</Button>
        </div>
      </div>
      {loading ? (
        <div className="rounded-xl border border-border/40 bg-card p-4 shadow-soft"><div className="space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div></div>
      ) : !report ? (
        <div className="rounded-xl border border-border/40 bg-card p-6 text-center shadow-soft"><p className="text-sm text-muted-foreground">Daily report unavailable — no account activity for this date.</p><p className="mt-1 text-xs text-muted-foreground/70">Historical account snapshots are not available yet.</p></div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-border/50 bg-card p-4 shadow-soft">
            <div className="space-y-1.5 divide-y divide-border/30">
              <div className="flex justify-between py-1.5 text-sm"><span className="text-muted-foreground">Opening Balance</span><span className="font-mono font-semibold tabular-nums">{fmtRs(report.openingBalance)}</span></div>
              <div className="flex justify-between py-1.5 text-sm"><span className="text-muted-foreground">Deposits</span><span className="font-mono font-semibold tabular-nums text-success">+{fmtRs(report.deposits)}</span></div>
              <div className="flex justify-between py-1.5 text-sm"><span className="text-muted-foreground">Withdrawals</span><span className="font-mono font-semibold tabular-nums text-destructive">-{fmtRs(report.withdrawals)}</span></div>
              <div className="flex justify-between py-1.5 text-sm"><span className="text-muted-foreground">Gross Realized P&L</span><span className={report.grossRealizedPnl >=0 ? 'text-success font-mono font-semibold tabular-nums':'text-destructive font-mono font-semibold tabular-nums'}>{fmtPnl(report.grossRealizedPnl)}</span></div>
              <div className="flex justify-between py-1.5 text-sm"><span className="text-muted-foreground">Total Charges</span><span className="font-mono font-semibold tabular-nums text-destructive">{report.totalCharges>0 ? `-${fmtRs(report.totalCharges)}` : fmtRs(0)}</span></div>
              <div className="flex justify-between py-2 text-sm font-bold border-t border-border/50"><span>Net Realized P&L</span><span className={report.netRealizedPnl>=0?'text-success':'text-destructive'}>{fmtPnl(report.netRealizedPnl)}</span></div>
              <div className="flex justify-between py-1.5 text-sm"><span className="text-muted-foreground">Closing Equity</span><span className="font-mono font-semibold tabular-nums">{fmtRs(report.closingEquity)}</span></div>
              {report.peakEquity == null && <div className="pt-2 text-[11px] text-muted-foreground">Peak/Lowest equity: Not available — intraday snapshots not yet captured.</div>}
            </div>
          </div>
          <div className="rounded-xl border border-border/50 bg-card p-4 shadow-soft">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trading Activity</h3>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/30 p-2"><div className="text-lg font-bold tabular-nums">{report.orders}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Orders</div></div>
              <div className="rounded-lg bg-success/10 p-2"><div className="text-lg font-bold tabular-nums text-success">{report.filledOrders}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Filled</div></div>
              <div className="rounded-lg bg-destructive/10 p-2"><div className="text-lg font-bold tabular-nums text-destructive">{report.rejectedOrders}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Rejected</div></div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-muted/30 p-2"><div className="text-lg font-bold tabular-nums">{report.openPositions}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Open Pos</div></div>
              <div className="rounded-lg bg-teal/10 p-2"><div className="text-lg font-bold tabular-nums">{report.closedPositions}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Closed</div></div>
              <div className="rounded-lg bg-muted/30 p-2"><div className="text-lg font-bold tabular-nums">{report.cancelledOrders}</div><div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cancelled</div></div>
            </div>
            <div className="mt-3 rounded-md bg-muted/20 p-2 text-[11px] text-muted-foreground">Unrealized today: <span className="font-semibold text-foreground">{fmtPnl(report.unrealizedPnl)}</span> · Opening equity {fmtRs(report.openingEquity)}</div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- page ----------------

export default function AccountPage() {
  const mode = useAccountMode();
  const { funds, history, status, loading, error, kotakError, lastSuccessAt, freshness, refresh } = useAccountData();
  const [loginOpen, setLoginOpen] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const { toast } = useToast();
  // Daily report state — date scoped, defaults to today (IST trading date)
  const [dailyDate, setDailyDate] = useState(() => istDateKey());
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  // Dummy live account for P&L sync (unrealized updates with LTP)
  const { state: dummyState } = useDummyState(4000, mode === 'demo');
  const positionsCount = useMemo(() => (dummyState?.positions || []).filter(p=> p.netQuantity!==0).length, [dummyState?.positions]);
  const dummyAccount = dummyState?.account ?? null;

  const handleRefresh = useCallback(() => { void refresh(); }, [refresh]);

  const refreshDaily = useCallback(async (d: string) => {
    if (mode !== 'demo') { setDailyReport(null); return; }
    setDailyLoading(true);
    try { const r = await getDailyReport(d); setDailyReport(r); } catch { setDailyReport(null); } finally { setDailyLoading(false); }
  }, [mode]);

  useEffect(() => { void refreshDaily(dailyDate); }, [dailyDate, refreshDaily, history.length]);
  // Real-time unrealized: when LTP pushes, dummyState updates → SummaryGrid re-renders without refetching history
  useEffect(() => { if (mode==='demo' && dummyState) { /* heartbeat for live P&L */ } }, [dummyState?.account?.unrealizedPnl]);

  const handleLogin = async () => {
    setLoggingIn(true);
    try {
      const res = await triggerLogin();
      const ok = Boolean(res?.ok);
      toast({ title: ok ? 'Kotak login successful' : 'Kotak login failed', description: String(res?.message ?? ''), variant: ok ? undefined : 'destructive' });
      setLoginOpen(false);
      refresh();
    } catch (err) {
      toast({ title: 'Login request failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally { setLoggingIn(false); }
  };

  const updatedLabel = lastSuccessAt != null ? `Updated ${new Date(lastSuccessAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}` : undefined;
  const kotakConnected = mode === 'api' ? status?.kotakConnected ?? null : null;
  const needLogin = mode === 'api' && kotakConnected === false;
  const stale = freshness === 'stale';

  return (
    <div className="space-y-6">
      {/* MODE NOTE: mode selector lives ONLY in the Trading Terminal sidebar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Account</h1>
          <p className="text-sm text-muted-foreground">
            {mode === 'demo'
              ? 'Dummy Trading Engine — virtual balance and ledger'
              : 'Live funds, margin health and ledger — one dashboard'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LiveStatus freshness={mode === 'demo' ? 'live' : freshness} updatedLabel={updatedLabel} />
          <RefreshButton onClick={handleRefresh} refreshing={loading} />
        </div>
      </div>

      {/* API-mode error banner: keeps STALE values visible, offers retry/login */}
      {mode === 'api' && error != null && (
        <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] p-3 sm:flex-row sm:items-center">
          <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 text-xs">
            <span className="font-semibold text-destructive">{kotakError ? 'Kotak Neo error' : 'Load failed'}.</span>{' '}
            <span className="text-muted-foreground">{error}</span>
            {stale && lastSuccessAt != null && (
              <span className="block text-[10px] text-muted-foreground">
                Showing last-known balances, marked STALE until refresh succeeds.
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {needLogin && (
              <Button size="sm" variant="outline" className="h-7 gap-1.5 rounded-lg text-xs" onClick={() => setLoginOpen(true)}>
                <LogIn className="h-3 w-3" /> Login
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-7 gap-1.5 rounded-lg text-xs" onClick={handleRefresh} disabled={loading}>
              <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} /> Retry
            </Button>
          </div>
        </div>
      )}

      {/* BALANCE SUMMARY — compact 5 per spec: Balance/Equity, Available, Used, Net P&L, Charges */}
      <section className="space-y-3">
        <h2 className="px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
          Account Summary {mode === 'demo' ? '· Demo' : '· Kotak Neo'}
        </h2>
        <SummaryGrid funds={funds} loading={loading} stale={stale} daily={dailyReport} account={dummyAccount as any} positionsCount={positionsCount} />
      </section>

      {/* DAILY REPORT — mandatory, date scoped */}
      <DailyReportSection
        date={dailyDate}
        report={dailyReport}
        loading={dailyLoading}
        onPrev={() => setDailyDate(shiftDateKey(dailyDate, -1))}
        onNext={() => {
          const iso = shiftDateKey(dailyDate, 1);
          if (iso <= istDateKey()) setDailyDate(iso);
        }}
        onToday={() => setDailyDate(istDateKey())}
      />

      {/* HEALTH + MARGIN compact */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AccountHealthCard status={status} mode={mode} fundsLastSuccessAt={lastSuccessAt} />
        <MarginUtilisation funds={funds} />
      </section>

      {/* MANAGE FUNDS — compact per spec */}
      {mode === 'demo' && (
        <ManageDemoFunds
          withdrawable={funds?.withdrawableAmount ?? 0}
          onChanged={() => { void refresh(); void refreshDaily(dailyDate); }}
        />
      )}

      {/* FUNDS HISTORY — ledger table */}
      <FundsHistory transactions={history} source={funds?.source ?? (mode === 'demo' ? 'demo-engine' : 'kotak-neo')} loading={loading} />

      {/* Login dialog (API mode) */}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Login to Kotak Neo</DialogTitle>
            <DialogDescription>
              API Mode shows real broker data and requires an active Kotak login session.
              Trigger a server-side login, then retry.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setLoginOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleLogin} disabled={loggingIn}>
              {loggingIn
                ? <><RefreshCw className="mr-1.5 h-4 w-4 animate-spin" /> Logging in…</>
                : <><LogIn className="mr-1.5 h-4 w-4" /> Login</>}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
