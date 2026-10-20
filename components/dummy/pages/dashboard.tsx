'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Wallet,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Receipt,
  Briefcase,
  Zap,
  Bell,
  ShoppingCart,
  Target,
  BarChart3,
  PieChart,
  Layers,
  CircleDollarSign,
  Clock,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Gauge, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { pnlTone, StatusBadge, ErrorState, EmptyState, SectionHeading, LiveIndicator } from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { getDummyWatchlists } from '@/lib/dummy';
import { DummyThemedPage, MarketSessionCard, DummyBadge, VirtualFundsNote, LivePulse } from '@/components/dummy/ui';
import { EngineStatusCard } from '@/components/dashboard/engine-status-card';
import { BrokerCardsSection } from '@/components/broker-terminal/broker-cards';
import { equityLabel, sessionLabel, orderStatusTone } from '@/lib/dummy';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { formatIST } from '@/lib/ist';
import { useDummyTheme } from '@/lib/dummy-theme';
import { cn } from '@/lib/utils';
import type { SectionsPayload } from '@/app/_pages/market-watch/mw-shared';

function fmt(v?: number | null): string {
  return v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pnlClass(v?: number | null) {
  const n = Number(v || 0);
  if (n > 0) return 'text-emerald-500';
  if (n < 0) return 'text-red-500';
  return '';
}

function pnlToneSafe(v?: number | null): 'success' | 'danger' | 'neutral' {
  return pnlTone(Number(v || 0)) as 'success' | 'danger' | 'neutral';
}

function toneText(tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral') {
  switch (tone) {
    case 'success': return 'text-emerald-500';
    case 'danger': return 'text-red-500';
    case 'warning': return 'text-amber-500';
    case 'info': return 'text-sky-500';
    default: return 'text-foreground';
  }
}

function KpiCell({ icon: Icon, label, value, sub, tone, pulse, unavailable }: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  pulse?: string | number;
  unavailable?: boolean;
}) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-background px-3 py-2.5" data-verify={label}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-primary/50 to-transparent" />
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {label}
      </div>
      {unavailable ? (
        <div className="mt-0.5 truncate text-sm font-semibold text-muted-foreground">Unavailable</div>
      ) : (
        <LivePulse value={pulse ?? value} className={cn('mt-0.5 block truncate text-base font-semibold tabular-nums', toneText(tone))}>
          {value}
        </LivePulse>
      )}
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function WatchlistStrip({ watchlist, connected }: { watchlist: string[]; connected: boolean }) {
  const { latest } = useLatestTicks(true);
  const rows = watchlist
    .map((s) => {
      const t = latest.get(s);
      return t && typeof t.ltp === 'number' ? { symbol: s, ltp: t.ltp, ts: t.ts } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  useEffect(() => {
    for (const r of rows) feedDummyLtp(r.symbol, r.ltp);
  }, [rows]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <LiveIndicator live={connected} label={connected ? 'Live ticks connected' : 'Tick feed offline'} />
        {!connected && <span>prices below are the last values received from the single websocket pipeline.</span>}
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">Add symbols to your watchlist to stream live LTP on the dashboard.</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map((r) => (
            <div key={r.symbol} className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2">
              <span className="text-sm font-semibold">{r.symbol}</span>
              <LivePulse value={r.ltp} className="text-sm font-mono tabular-nums text-foreground">
                {r.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </LivePulse>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact top-movers strip (summary widget, not a second Market Watch page).
 *
 * Reuses the canonical `SectionsPayload` contract from
 * `app/_pages/market-watch/mw-shared` and the canonical engine read
 * `/api/market-watch/sections`, so it can never disagree with the full Market
 * Watch page. It deliberately sends NO filter/circuit query parameters:
 * eligibility, circuit safety and limits are engine config
 * (`MWR_CIRCUIT_*` / `MWR_FILTER_*`). This component used to call
 * `/api/phase2/watch?...&circuitSafety=true&maxChangePercent=18` — a frontend
 * circuit rule the backend reports as engine-owned and therefore never applied,
 * so the strip could show rows the engine had not cleared.
 */
function TopStocksStrip() {
  const { latest } = useLatestTicks(true);
  const [stocks, setStocks] = useState<Array<{ symbol: string; ltp: number | null; changePct: number | null; }>>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/market-watch/sections', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: SectionsPayload) => {
        if (cancelled) return;
        const rows: Array<{ symbol: string; ltp: number | null; changePct: number | null; }> = [];
        for (const items of Object.values(data?.sections ?? {})) {
          for (const item of items ?? []) {
            rows.push({ symbol: item.symbol, ltp: item.ltp ?? null, changePct: item.changePercent ?? null });
          }
        }
        setStocks(rows.slice(0, 10));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (stocks.length === 0) return null;

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Top market stocks — live LTP</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead className="text-right">LTP</TableHead>
              <TableHead className="text-right">Change %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {stocks.map((s) => {
              const t = latest.get(s.symbol);
              const ltp = t && typeof t.ltp === 'number' ? t.ltp : s.ltp;
              return (
                <TableRow key={s.symbol}>
                  <TableCell className="font-medium">{s.symbol}</TableCell>
                  <TableCell className="text-right tabular-nums">{ltp != null ? ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</TableCell>
                  <TableCell className={cn('text-right tabular-nums', pnlClass(s.changePct))}>
                    {s.changePct != null ? `${s.changePct > 0 ? '+' : ''}${s.changePct.toFixed(2)}%` : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export default function DummyDashboard() {
  const { state, error, loading, refresh } = useDummyState(3000);
  useDummyTheme();
  const [watchlist, setWatchlist] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getDummyWatchlists()
      .then((res) => {
        if (cancelled) return;
        const items = res?.items ?? [];
        const active = items.find((l) => l.id === res?.activeId) ?? items[0];
        setWatchlist((active?.symbols ?? []).map((s) => s.symbol).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const positionsSymbols = useMemo(
    () => new Set((state?.positions || []).map((p) => p.symbol)),
    [state?.positions],
  );

  const { latest, connected: wsConnected } = useLatestTicks(true);
  useEffect(() => {
    const targets = new Set([
      ...watchlist,
      ...(state?.alerts || []).map((a) => a.symbol),
      ...(state?.targets || []).map((t) => t.symbol),
      ...positionsSymbols,
    ]);
    for (const sym of targets) {
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) feedDummyLtp(sym, t.ltp);
    }
  }, [latest, watchlist, positionsSymbols, state?.alerts, state?.targets]);

  const marketOpen = state?.market?.market_status === 'OPEN';

  type KpiItem = {
    icon: React.ElementType;
    label: string;
    value: string;
    tone: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
    pulse?: string | number;
    sub?: string;
  };

  const groups = useMemo(() => {
    if (!state) return null;
    const a = state.account;
    let invested = 0;
    let currentValue = 0;
    let exposure = 0;
    for (const p of state.positions) {
      const net = Math.abs(p.netQuantity);
      const entry = p.netQuantity > 0 ? p.averageBuyPrice : p.averageSellPrice;
      invested += entry * net;
      currentValue += p.ltp * net;
      exposure += p.ltp * net * (p.product === 'MIS' ? 0.2 : 1.0);
    }
    const completed = state.orders.filter((o) => {
      const s = (o.status || '').toUpperCase();
      return s === 'COMPLETE' || s === 'FILLED';
    }).length;
    const inProcess = state.orders.filter((o) => {
      const s = (o.status || '').toUpperCase();
      return s === 'TRIGGER_PENDING' || s === 'PARTIALLY_FILLED' || s === 'EXECUTING';
    }).length;
    const pending = state.orders.filter((o) => {
      const s = (o.status || '').toUpperCase();
      return s === 'OPEN' || s === 'PENDING';
    }).length;
    const staleSub = marketOpen ? undefined : 'Market closed — last known values';

    const account: KpiItem[] = [
      { icon: Wallet, label: 'Virtual balance', value: equityLabel(a.balance), tone: 'success', pulse: a.balance },
      { icon: CircleDollarSign, label: 'Free margin', value: equityLabel(a.freeMargin), tone: 'success', pulse: a.freeMargin },
      { icon: Zap, label: 'Used margin', value: equityLabel(a.usedMargin), tone: 'warning', pulse: a.usedMargin },
      { icon: Gauge, label: 'Margin utilization', value: `${state.risk.marginUtilizationPct ?? 0}%`, tone: 'warning', pulse: state.risk.marginUtilizationPct },
      { icon: Receipt, label: 'Charges', value: equityLabel(a.totalCharges), tone: 'neutral', pulse: a.totalCharges },
    ];

    const pnl: KpiItem[] = [
      { icon: Layers, label: 'Invested', value: equityLabel(invested), tone: 'neutral', pulse: invested, sub: staleSub },
      { icon: PieChart, label: 'Current value', value: equityLabel(currentValue), tone: 'neutral', pulse: currentValue, sub: staleSub },
      { icon: ShieldCheck, label: 'Exposure', value: equityLabel(exposure), tone: 'neutral', pulse: exposure, sub: staleSub },
      { icon: TrendingUp, label: 'Unrealized P&L', value: equityLabel(a.unrealizedPnl), tone: pnlToneSafe(a.unrealizedPnl), pulse: a.unrealizedPnl },
      { icon: BarChart3, label: 'Realized P&L', value: equityLabel(a.realizedPnl), tone: pnlToneSafe(a.realizedPnl), pulse: a.realizedPnl },
      { icon: ArrowUpRight, label: 'Total P&L', value: equityLabel(a.totalPnl), tone: pnlToneSafe(a.totalPnl), pulse: a.totalPnl },
    ];

    const activity: KpiItem[] = [
      { icon: Briefcase, label: 'Open positions', value: String(state.positions.filter((p) => p.netQuantity !== 0).length), tone: 'info', pulse: state.positions.length },
      { icon: ShoppingCart, label: 'Orders today', value: String(a.dailyOrders ?? 0), tone: 'neutral', pulse: a.dailyOrders },
      { icon: CheckCircle2, label: 'Completed', value: String(completed), sub: 'orders', tone: 'success', pulse: completed },
      { icon: Loader2, label: 'In process', value: String(inProcess), sub: 'orders', tone: 'warning', pulse: inProcess },
      { icon: AlertTriangle, label: 'Pending', value: String(pending), sub: 'orders', tone: 'warning', pulse: pending },
      { icon: Bell, label: 'Active alerts', value: String(state.risk.activeAlerts ?? 0), sub: `Unread ${state.unreadNotifications}`, tone: state.risk.activeAlerts ? 'warning' : 'neutral', pulse: state.risk.activeAlerts },
    ];

    return { account, pnl, activity };
  }, [state, marketOpen]);

  if (loading && !state) {
    return (
      <DummyThemedPage>
        <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Loading Dummy terminal state…</div>
      </DummyThemedPage>
    );
  }

  if (error && !state) {
    return (
      <DummyThemedPage>
        <ErrorState message={error} onRetry={() => void refresh()} />
      </DummyThemedPage>
    );
  }

  if (!state || !groups) return null;

  return (
    <DummyThemedPage>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Dummy Terminal</h1>
            <DummyBadge />
          </div>
          <p className="text-sm text-muted-foreground">
            Real market data · simulated execution · virtual capital — session {sessionLabel(state.market?.market_session || 'CLOSED')}
          </p>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <Button asChild size="sm" variant="outline">
            <Link href="/trading/trade"><ShoppingCart className="h-4 w-4" /> Trade</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/trading/watchlist"><Sparkles className="h-4 w-4" /> Watchlist</Link>
          </Button>
        </div>
      </div>

      {/* 0. Engine status card at page top */}
      <EngineStatusCard />

      {/* 1. Market Session — premium advanced strip (no dummy timestamps) */}
      <MarketSessionCard
        market={state.market}
        session={state.session}
        connected={wsConnected}
      />

      {/* 2. Real-time KPI grid — grouped, each cell pulses only on real value change */}
      {[
        { heading: 'Account — virtual capital', items: groups.account },
        { heading: 'Exposure & P&L', items: groups.pnl },
        { heading: 'Orders & activity', items: groups.activity },
      ].map((group) => (
        <div key={group.heading} className="space-y-2">
          <SectionHeading>{group.heading}</SectionHeading>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {group.items.map((ind) => (
              <KpiCell
                key={ind.label}
                icon={ind.icon}
                label={ind.label}
                value={ind.value}
                sub={ind.sub}
                tone={ind.tone}
                pulse={ind.pulse}
              />
            ))}
          </div>
        </div>
      ))}

      {/* 3. Broker Terminal — the shared 4-card section (Kotak · Shoonya · Dummy · Combined) */}
      <BrokerCardsSection heading="Broker Terminals" reloadKey={loading ? 1 : 0} />

      {/* 4. Live market watch + risk picture */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4" /> Live Market Watch
            </CardTitle>
          </CardHeader>
          <CardContent>
            <WatchlistStrip watchlist={watchlist} connected={wsConnected} />
            <TopStocksStrip />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4" /> Targets &amp; Alerts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Active targets</span>
              <span className="font-semibold">{state.risk.pendingTargets}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Active alerts</span>
              <span className="font-semibold">{state.risk.activeAlerts}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Unread notifications</span>
              <StatusBadge status={state.unreadNotifications > 0 ? 'warning' : 'neutral'} label={String(state.unreadNotifications)} />
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button asChild variant="outline" size="sm"><Link href="/trading/calendar">Market calendar</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 5. Positions snapshot + recent orders */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Briefcase className="h-4 w-4" /> Positions
              <span className="ml-auto">
                <Button asChild variant="ghost" size="sm"><Link href="/trading/positions">View all</Link></Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {state.positions.length === 0 ? (
              <EmptyState
                icon={Briefcase}
                title="No open positions"
                description="Place a trade to build a simulated position. Execution uses real market LTP."
                action={<Button asChild variant="outline" size="sm"><Link href="/trading/trade">Place a trade</Link></Button>}
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg</TableHead>
                      <TableHead className="text-right">LTP</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.positions.slice(0, 5).map((p) => (
                      <TableRow key={p.symbol}>
                        <TableCell className="font-medium">{p.symbol}</TableCell>
                        <TableCell>
                          <Badge variant={p.netQuantity > 0 ? 'default' : 'destructive'}>{p.netQuantity > 0 ? 'LONG' : 'SHORT'}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{Math.abs(p.netQuantity)}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.averageBuyPrice || p.averageSellPrice || '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.ltp}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', pnlClass(p.unrealizedPnl))}>
                          {p.unrealizedPnl.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Clock className="h-4 w-4" /> Trading activity
              <span className="ml-auto">
                <Button asChild variant="ghost" size="sm"><Link href="/trading/history">All</Link></Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Today&apos;s trades</span>
              <span className="font-semibold tabular-nums">{state.session.trade_count ?? 0}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Turnover</span>
              <span className="font-semibold tabular-nums">{fmt(state.session.turnover ?? 0)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Baskets</span>
              <span className="font-semibold tabular-nums">{state.session.basket_count ?? 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 6. Recent orders */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowDownRight className="h-4 w-4" /> Recent Orders
            <span className="ml-auto">
              <Button asChild variant="ghost" size="sm"><Link href="/trading/trade">Orders module</Link></Button>
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {state.orders.length === 0 ? (
            <EmptyState icon={ArrowDownRight} title="No orders yet" description="Order history will appear here as simulated orders are placed." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
              <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Filled</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Avg Price</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.orders.slice(0, 7).map((o) => (
                      <TableRow key={o.orderId}>
                        <TableCell className="font-mono text-xs">{o.orderId}</TableCell>
                        <TableCell className="font-medium">{o.symbol}</TableCell>
                        <TableCell>
                          <span className={o.transactionType === 'BUY' ? 'text-emerald-500' : 'text-red-500'}>{o.transactionType}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">{o.filledQuantity ?? '—'}</TableCell>
                        <TableCell>{o.orderType}</TableCell>
                        <TableCell className="text-right tabular-nums">{o.price ? fmt(o.price) : 'MKT'}</TableCell>
                        <TableCell className="text-right tabular-nums">{o.averageTradedPrice ? fmt(o.averageTradedPrice) : '—'}</TableCell>
                        <TableCell><StatusBadge status={orderStatusTone(o.status)} label={o.status} /></TableCell>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">{o.orderDate ? formatIST(o.orderDate, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <VirtualFundsNote />
    </DummyThemedPage>
  );
}