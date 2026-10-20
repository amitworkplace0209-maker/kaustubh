'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertCircle, Archive, Briefcase, CalendarClock,
  CheckCircle2, Clock, CreditCard, Database,
  IndianRupee, Layers, PiggyBank, PieChart,
  Receipt, RefreshCw, ShoppingCart, TrendingDown, TrendingUp,
  Wallet, Eye, EyeOff, BarChart3, Target, ShieldCheck,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CARD_TONE, MetricCard, SectionHeading,
  pnlTone, stateTone, type AccentTone,
} from '@/components/design-system';
import {
  getTradingDashboard,
  type TradingDashboardResponse,
  type DashboardSectionStatus,
  type CanonicalFunds,
} from '@/lib/api';
import { useRealtime } from '@/components/realtime-provider';
import { normalizeOrderStatus } from '@/lib/normalizers';
import { fmtPct, fmtPnl, fmtQty, fmtRs, pnlClr, toNum } from '@/lib/formatters';
import { extractBrokerCharges } from '@/lib/charge-service';
import type { ChargeBreakdown } from '@/lib/charge-service';
import { MarketSessionCard } from '@/components/dashboard/market-session-card';
import { BrokerCardsSection } from '@/components/broker-terminal/broker-cards';
import { TradingOpsRow } from '@/components/dashboard/session-health-cards';
import { TopPositions } from '@/components/dashboard/top-positions';
import { useServerNow, ageLabel, freshnessOf } from '@/lib/time-engine';
import { EngineStatusCard } from '@/components/dashboard/engine-status-card';
import { uiSection, type UiPublishPayload } from '@/app/_pages/market-watch/mw-shared';

// ---------------------------------------------------------------------------
// Privacy toggle
// ---------------------------------------------------------------------------

function MaskToggle({
  masked, onToggle, label,
}: { masked: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={masked ? `Show ${label}` : `Hide ${label}`}
      aria-pressed={masked}
      title={masked ? `Show ${label}` : `Hide ${label}`}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {masked ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section status tag (backend-driven)
// ---------------------------------------------------------------------------

const SECTION_LABEL: Record<DashboardSectionStatus, string> = {
  ok: 'Live',
  not_configured: 'Not Configured',
  not_logged_in: 'Not Connected',
  unavailable: 'Unavailable',
  error: 'Error',
};

type SysState = 'ok' | 'bad' | 'warn' | 'unknown';
const DOT_TONE: Record<SysState, string> = {
  ok: 'bg-success [box-shadow:0_0_5px_hsl(var(--success)/0.7)]',
  bad: 'bg-destructive [box-shadow:0_0_5px_hsl(var(--destructive)/0.6)]',
  warn: 'bg-warning animate-pulse',
  unknown: 'bg-muted-foreground/50 animate-pulse',
};
const STATUS_TEXT_TONE: Record<SysState, string> = {
  ok: 'text-success',
  bad: 'text-destructive',
  warn: 'text-warning',
  unknown: 'text-muted-foreground',
};
const SECTION_TONE: Record<DashboardSectionStatus, SysState> = {
  ok: 'ok',
  not_configured: 'warn',
  not_logged_in: 'warn',
  unavailable: 'warn',
  error: 'bad',
};

function SectionStatus({
  status, timestamp, now,
}: {
  status: DashboardSectionStatus | null; timestamp: string | null | undefined;
  now?: number;
}) {
  if (status == null) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50 animate-pulse" />
        Checking…
      </span>
    );
  }
  const tone = SECTION_TONE[status];
  const freshness = status === 'ok' && timestamp ? freshnessOf(timestamp, now ?? Date.now()) : 'UNKNOWN';
  const stale = freshness === 'STALE';
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-normal tabular-nums">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stale ? 'bg-warning animate-pulse' : DOT_TONE[tone]}`} />
      <span className={stale ? 'text-warning' : STATUS_TEXT_TONE[tone]}>{stale ? 'Stale' : SECTION_LABEL[status]}</span>
      {status === 'ok' && timestamp ? (
        <span className={stale ? 'text-warning/80' : 'text-muted-foreground/70'} title={fmtTime(timestamp)}>
          · {ageLabel(timestamp, now ?? Date.now()) ?? fmtTime(timestamp)}
        </span>
      ) : null}
    </span>
  );
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ---------------------------------------------------------------------------
// Canonical consumers
// ---------------------------------------------------------------------------

const MASKED_AMOUNT = '₹••••••';

type OrderCounts = {
  total: number; executed: number; pending: number; rejected: number; cancelled: number;
};

type PositionTotals = {
  realized: number; unrealized: number; gross: number; charges: number; net: number;
  exposure: number; openMarketValue: number; pnlPct: number | null;
  longCount: number; shortCount: number; closedCount: number;
  longQty: number; shortQty: number;
};

function rawOrderStatus(o: any): string {
  return String(o?.ordSt ?? o?.status ?? o?.stat ?? '');
}

function countOrders(rows: any[]): OrderCounts {
  let executed = 0, pending = 0, rejected = 0, cancelled = 0;
  for (const o of rows) {
    switch (normalizeOrderStatus(rawOrderStatus(o))) {
      case 'executed': case 'partial': executed++; break;
      case 'pending': case 'open': pending++; break;
      case 'rejected': rejected++; break;
      case 'cancelled': case 'expired': cancelled++; break;
      default: pending++; break;
    }
  }
  return { total: rows.length, executed, pending, rejected, cancelled };
}

function pickNum(r: Record<string, unknown>, ...names: string[]): number | null {
  for (const k of names) {
    const v = r[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function computeAggregatedCharges(rows: any[]) {
  const executed = rows.filter((o) => {
    const s = normalizeOrderStatus(rawOrderStatus(o));
    return s === 'executed' || s === 'partial';
  });
  if (executed.length === 0) {
    return {
      brokerage: 0, stt: 0, exchangeCharges: 0, gst: 0,
      sebiCharges: 0, stampDuty: 0, otherCharges: 0, totalCharges: 0,
      orderCount: 0, confirmed: false,
    };
  }
  const totals = {
    brokerage: 0, stt: 0, exchangeCharges: 0, gst: 0,
    sebiCharges: 0, stampDuty: 0, otherCharges: 0, totalCharges: 0,
  };
  let allBrokerReported = true;
  let pricedCount = 0;
  for (const order of executed) {
    const r = (order && typeof order === 'object' ? order : {}) as Record<string, unknown>;
    const brokerCharges: ChargeBreakdown | null = extractBrokerCharges(r);
    const qty = pickNum(r, 'filledQuantity', 'fldQty', 'filled_quantity', 'quantity', 'qty', 'filledQty') ?? 0;
    const price = pickNum(r, 'averagePrice', 'avgPrc', 'average_traded_price', 'avg_price', 'price') ?? 0;
    let part: ChargeBreakdown;
    if (brokerCharges && qty > 0 && price > 0) {
      part = brokerCharges;
    } else if (qty > 0 && price > 0) {
      const turnover = Math.round(qty * price * 100) / 100;
      const brokerage = Math.round(turnover * 0.0003 * 100) / 100;
      const stt = Math.round(turnover * 0.00025 * 100) / 100;
      const exchangeCharges = Math.round(turnover * 0.0000345 * 100) / 100;
      const sebiCharges = Math.round(turnover * 0.000001 * 100) / 100;
      const stampDuty = Math.round(turnover * 0.00003 * 100) / 100;
      const taxableBase = Math.max(0, brokerage) + Math.max(0, exchangeCharges) + Math.max(0, sebiCharges);
      const gst = Math.round(taxableBase * 0.18 * 100) / 100;
      part = {
        brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty,
        otherCharges: 0,
        totalCharges: Math.round((brokerage + stt + exchangeCharges + sebiCharges + stampDuty + gst) * 100) / 100,
      };
      allBrokerReported = false;
    } else {
      continue;
    }
    pricedCount++;
    totals.brokerage = Math.round((totals.brokerage + part.brokerage) * 100) / 100;
    totals.stt = Math.round((totals.stt + part.stt) * 100) / 100;
    totals.exchangeCharges = Math.round((totals.exchangeCharges + part.exchangeCharges) * 100) / 100;
    totals.gst = Math.round((totals.gst + part.gst) * 100) / 100;
    totals.sebiCharges = Math.round((totals.sebiCharges + part.sebiCharges) * 100) / 100;
    totals.stampDuty = Math.round((totals.stampDuty + part.stampDuty) * 100) / 100;
    totals.otherCharges = Math.round((totals.otherCharges + part.otherCharges) * 100) / 100;
    totals.totalCharges = Math.round((totals.totalCharges + part.totalCharges) * 100) / 100;
  }
  return { ...totals, orderCount: pricedCount, confirmed: pricedCount > 0 && allBrokerReported };
}

type CanonicalPosition = {
  side: 'LONG' | 'SHORT' | 'FLAT';
  netSigned: number;
  qty: number;
  buyQuantity: number;
  sellQuantity: number;
  averagePrice: number;
  ltp: number;
  marketValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  netPnl: number;
  charges: number | null;
  product: string;
};

function toPosition(r: any): CanonicalPosition {
  const row = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
  const netSigned = toNum(row.netQuantity) ?? 0;
  const positionType = String(row.positionType ?? '').toUpperCase();
  const side: CanonicalPosition['side'] =
    positionType === 'SHORT' ? 'SHORT' : positionType === 'LONG' ? 'LONG' : 'FLAT';
  const charges = row.estimatedCharges != null ? (toNum(row.estimatedCharges) ?? 0) : null;
  const gross = toNum(row.grossPnl) ?? 0;
  return {
    side,
    netSigned,
    qty: Math.abs(netSigned),
    buyQuantity: toNum(row.buyQuantity) ?? 0,
    sellQuantity: toNum(row.sellQuantity) ?? 0,
    averagePrice: toNum(row.averagePrice) ?? 0,
    ltp: toNum(row.ltp) ?? 0,
    marketValue: toNum(row.marketValue) ?? 0,
    realizedPnl: toNum(row.realizedPnl) ?? 0,
    unrealizedPnl: toNum(row.unrealizedPnl) ?? 0,
    grossPnl: gross,
    netPnl: charges != null ? gross - charges : gross,
    charges,
    product: String(row.product ?? ''),
  };
}

function computePositionTotals(positions: CanonicalPosition[]): PositionTotals {
  let realized = 0, unrealized = 0, charges = 0;
  let exposure = 0, openMarketValue = 0;
  let longCount = 0, shortCount = 0, closedCount = 0;
  let longQty = 0, shortQty = 0;
  for (const p of positions) {
    realized += p.realizedPnl;
    unrealized += p.unrealizedPnl;
    charges += p.charges ?? 0;
    if (p.side !== 'FLAT') {
      exposure += p.netSigned * p.averagePrice;
      openMarketValue += p.marketValue;
      if (p.side === 'LONG') { longCount++; longQty += p.qty; }
      else { shortCount++; shortQty += p.qty; }
    } else if (p.buyQuantity > 0 || p.sellQuantity > 0) {
      closedCount++;
    }
  }
  const gross = realized + unrealized;
  const net = gross - charges;
  const pnlPct = exposure !== 0 ? (gross / Math.abs(exposure)) * 100 : null;
  return {
    realized, unrealized, gross, charges, net, exposure, openMarketValue, pnlPct,
    longCount, shortCount, closedCount, longQty, shortQty,
  };
}

function isSectionDown(status: DashboardSectionStatus | null | undefined): boolean {
  return status != null && status !== 'ok';
}

// ---------------------------------------------------------------------------
// Live Market Watch — compact engine summary, honest empty state (no fabricated
// rows). This is a SUMMARY WIDGET, not a second Market Watch page: it renders
// counters plus a short preview and links to the canonical page for the full UI.
//
// It deliberately reuses the canonical contracts from
// `app/_pages/market-watch/mw-shared` instead of declaring local copies. The old
// local `MwUi` type typed `sections` as a name-keyed record, but
// `/api/market-watch/ui` returns an ORDERED ARRAY of `{section, items}` — so the
// Top Gainers / Top Losers previews below could never render and always showed
// the "waiting for ranking data" placeholder.
// ---------------------------------------------------------------------------
const MW_POLL_MS = 15000;

function LiveMarketWatchSection({ compact }: { compact?: boolean }) {
  const [mw, setMw] = useState<UiPublishPayload | null>(null);
  const [mwErr, setMwErr] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchMw = useCallback(async () => {
    try {
      const res = await fetch('/api/market-watch/ui', { cache: 'no-store' });
      if (!res.ok) throw new Error(`market watch ${res.status}`);
      const data = (await res.json()) as UiPublishPayload;
      if (mountedRef.current) { setMw(data); setMwErr(null); }
    } catch (err) {
      if (mountedRef.current) setMwErr(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchMw();
    const t = setInterval(fetchMw, MW_POLL_MS);
    const onVisible = () => { if (!document.hidden) fetchMw(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mountedRef.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchMw]);

  const counts = mw?.statusCounts ?? {};
  const connected = mw?.feedState === 'CONNECTED';
  const gainers = uiSection(mw, 'top_gainers').slice(0, compact ? 3 : 4);
  const losers = uiSection(mw, 'top_losers').slice(0, compact ? 3 : 4);

  return (
    <section aria-label="Live Market Watch" className="space-y-2" data-verify="live-market-watch">
      <div className="flex items-center justify-between px-0.5">
        <SectionHeading>Live Market Watch</SectionHeading>
        <Link href="/trading/market-watch" className="text-[11px] font-medium text-muted-foreground hover:text-primary">
          Open Market Watch →
        </Link>
      </div>
      {mwErr != null ? (
        <Card className="border-border/60"><CardContent className="px-4 py-5 text-center text-xs text-muted-foreground">Market Watch engine unavailable — {mwErr}</CardContent></Card>
      ) : mw == null ? (
        <Card className="border-border/60"><CardContent className="px-4 py-6 text-center text-xs text-muted-foreground">Loading engine state…</CardContent></Card>
      ) : (
        <Card className="overflow-hidden border-border/60">
          <CardContent className="px-4 py-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-[11px] font-medium text-muted-foreground">Feed State</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold tabular-nums">
                  <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-warning animate-pulse'}`} />
                  {mw.feedState}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground">Live State</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">{mw.liveStateCount}</p>
                <p className="text-[10px] text-muted-foreground">of {mw.universeSize} universe</p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground">Statuses</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">
                  <span className="text-success">{counts.LIVE ?? 0}</span>
                  <span className="mx-1 text-muted-foreground">/</span>
                  <span className="text-warning">{counts.STALE ?? 0}</span>
                  <span className="mx-1 text-muted-foreground">/</span>
                  <span className="text-muted-foreground">{counts.PENDING ?? 0}</span>
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {(counts.NO_DATA ?? 0)} no-data · {(counts.INACTIVE ?? 0)} inactive
                </p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-muted-foreground">Index Version</p>
                <p className="mt-0.5 text-sm font-semibold tabular-nums">#{mw.indexVersion ?? 0}</p>
                <p className="text-[10px] text-muted-foreground">{mw.tradingDate || 'no trading date'} · {mw.generatedAt}</p>
              </div>
            </div>

            {(gainers.length > 0 || losers.length > 0) && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                    <TrendingUp className="h-3 w-3" /> Top Gainers
                  </p>
                  {gainers.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No gainers yet.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-border/40">
                        {gainers.map((r) => (
                          <tr key={r.token}>
                            <td className="py-1 font-medium">{r.symbol}</td>
                            <td className="py-1 text-right font-mono tabular-nums">{r.ltp != null ? `₹${fmtRs(r.ltp)}` : '—'}</td>
                            <td className={`py-1 text-right font-mono tabular-nums ${r.changePercent != null && r.changePercent > 0 ? 'text-success' : 'text-muted-foreground'}`}>
                              {r.changePercent != null ? `+${r.changePercent.toFixed(2)}%` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div>
                  <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-red-600 dark:text-red-400">
                    <TrendingDown className="h-3 w-3" /> Top Losers
                  </p>
                  {losers.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No losers yet.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <tbody className="divide-y divide-border/40">
                        {losers.map((r) => (
                          <tr key={r.token}>
                            <td className="py-1 font-medium">{r.symbol}</td>
                            <td className="py-1 text-right font-mono tabular-nums">{r.ltp != null ? `₹${fmtRs(r.ltp)}` : '—'}</td>
                            <td className={`py-1 text-right font-mono tabular-nums ${r.changePercent != null && r.changePercent < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {r.changePercent != null ? `${r.changePercent.toFixed(2)}%` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}

            {gainers.length === 0 && losers.length === 0 && (
              <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-border/50 px-3 py-3 text-center">
                <BarChart3 className="h-4 w-4 text-muted-foreground/40" />
                <p className="text-[11px] text-muted-foreground">
                  Waiting for ranking data — the engine warms up and publishes controlled snapshots every 30s.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function RecentOrdersSection({ rows, down, loading }: { rows: any[]; down: boolean; loading: boolean }) {
  const list = useMemo(() => {
    return (Array.isArray(rows) ? rows : []).slice(0, 5);
  }, [rows]);

  return (
    <section aria-label="Recent Orders" className="space-y-2" data-verify="recent-orders">
      <div className="flex items-center justify-between px-0.5">
        <SectionHeading>Recent Orders</SectionHeading>
        <Link href="/orders" className="text-[11px] font-medium text-muted-foreground hover:text-primary">
          View all →
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
      ) : down ? (
        <Card className="border-border/60"><CardContent className="px-4 py-6 text-center text-xs text-muted-foreground">Orders feed unavailable</CardContent></Card>
      ) : list.length === 0 ? (
        <Card className="border-border/60">
          <CardContent className="flex flex-col items-center justify-center gap-1.5 px-4 py-8 text-center">
            <ShoppingCart className="h-6 w-6 text-muted-foreground/30" />
            <p className="text-sm font-medium text-muted-foreground">No orders yet</p>
            <p className="text-xs text-muted-foreground/60">Place a trade to see orders here.</p>
            <Button size="sm" variant="outline" asChild className="mt-1"><Link href="/trading/trade">Trade</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-border/60">
          <div className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {list.map((r: any, i: number) => {
                  const s = String(r.status ?? r.ordSt ?? '—');
                  const side = String(r.transactionType ?? r.trnsTp ?? '—');
                  return (
                    <tr key={`${r.orderId ?? i}-${i}`} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-medium">{r.symbol ?? r.tradingSymbol ?? '—'}</td>
                      <td className="px-3 py-2">
                        <span className={side === 'BUY' ? 'text-success' : side === 'SELL' ? 'text-destructive' : 'text-muted-foreground'}>{side}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.quantity ?? r.qty ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.price != null ? fmtRs(Number(r.price)) : r.averagePrice != null ? fmtRs(Number(r.averagePrice)) : '—'}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-medium">{s}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.orderTime ? new Date(r.orderTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

function TradingActivitySection({ orderRows, totals, down, loading }: { orderRows: any[]; totals: PositionTotals; down: boolean; loading: boolean }) {
  const turnover = useMemo(() => {
    let t = 0;
    for (const o of orderRows) {
      const qty = toNum((o as any).filledQuantity ?? (o as any).quantity) ?? 0;
      const price = toNum((o as any).averagePrice ?? (o as any).price) ?? 0;
      if (qty > 0 && price > 0) t += qty * price;
    }
    return t;
  }, [orderRows]);

  if (loading) return <div className="grid grid-cols-3 gap-3"><Skeleton className="h-[88px]" /><Skeleton className="h-[88px]" /><Skeleton className="h-[88px]" /></div>;
  return (
    <section aria-label="Trading activity" className="space-y-2">
      <SectionHeading>Trading Activity — Today</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="border-border/60">
          <CardContent className="px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">Trades</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{down ? '—' : String(orderRows.filter((o) => normalizeOrderStatus(rawOrderStatus(o)) === 'executed').length)}</p>
            <p className="text-[11px] text-muted-foreground">{down ? 'feed unavailable' : 'executed today'}</p>
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardContent className="px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">Turnover</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{down ? '—' : fmtRs(turnover)}</p>
            <p className="text-[11px] text-muted-foreground">from executed orders</p>
          </CardContent>
        </Card>
        <Card className="border-border/60">
          <CardContent className="px-4 py-3">
            <p className="text-[11px] font-medium text-muted-foreground">Open Exposure</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{down ? '—' : fmtRs(Math.abs(totals.exposure))}</p>
            <p className="text-[11px] text-muted-foreground">{totals.longCount + totals.shortCount} open positions</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const [dash, setDash] = useState<TradingDashboardResponse | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [pnlMasked, setPnlMasked] = useState(true);
  const [investmentMasked, setInvestmentMasked] = useState(true);
  const mountedRef = useRef(true);
  const fetchedKeyRef = useRef<string>('');

  const { appConnection, state, hydrated } = useRealtime();
  const serverNow = useServerNow();

  const activeMode = state.terminal ?? state.session?.mode ?? null;
  const sessionStatus = state.session?.status ?? state.session?.state ?? null;
  const sessionModeLabel = String(activeMode ?? dash?.terminal ?? 'DUMMY').toUpperCase();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchDashboard = useCallback(async () => {
    setFetching(true);
    try {
      const res = await getTradingDashboard();
      if (!mountedRef.current) return;
      setDash(res);
      setFetchErr(null);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (/aborted/i.test(msg) || /timed out|timeout/i.test(msg)) {
        setFetchErr(null);
        return;
      }
      setFetchErr(msg);
    } finally {
      if (mountedRef.current) setFetching(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (appConnection === 'OFFLINE') return;
    const key = `${activeMode ?? '?'}|${sessionStatus ?? '?'}|${appConnection}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;
    fetchDashboard();
  }, [activeMode, sessionStatus, hydrated, appConnection, fetchDashboard]);

  useEffect(() => {
    const onSessionChange = () => { fetchedKeyRef.current = ''; fetchDashboard(); };
    window.addEventListener('kotak-session-changed', onSessionChange);
    const onVisible = () => { if (!document.hidden) fetchDashboard(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('kotak-session-changed', onSessionChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchDashboard]);

  const refreshAll = useCallback(() => {
    fetchedKeyRef.current = '';
    fetchDashboard();
  }, [fetchDashboard]);

  const loaded = dash != null;
  const isDemo = dash?.isDemo ?? sessionModeLabel.includes('DUMMY');
  const terminalName = dash?.broker ?? (isDemo ? 'Dummy Terminal' : 'Trading Terminal');

  const fSection = dash?.sections?.funds;
  const pSection = dash?.sections?.positions;
  const hSection = dash?.sections?.holdings;
  const oSection = dash?.sections?.orders;

  const f = (fSection?.data ?? null) as CanonicalFunds | null;
  const fStatus: DashboardSectionStatus | null = loaded && fSection ? fSection.status : null;
  const pStatus: DashboardSectionStatus | null = loaded && pSection ? pSection.status : null;
  const hStatus: DashboardSectionStatus | null = loaded && hSection ? hSection.status : null;
  const oStatus: DashboardSectionStatus | null = loaded && oSection ? oSection.status : null;

  const fAvailable = f?.freeMargin ?? null;
  const fUsed = f?.usedMargin ?? null;
  const fBlocked = f?.blockedMargin ?? null;
  const fCash = f?.cash ?? null;
  const fBalance = f?.balance ?? null;
  const fCollateral = f?.blockedMargin ?? null;
  const totalMargin = fUsed != null && fAvailable != null ? fUsed + fAvailable : fBalance;
  const utilization = totalMargin != null && totalMargin > 0 && fUsed != null ? Math.min(100, Math.max(0, (fUsed / totalMargin) * 100)) : null;

  const canonicalPositions = useMemo(() => {
    const rows = pSection?.data ?? [];
    return (Array.isArray(rows) ? rows : []).map(toPosition);
  }, [pSection]);

  const totals = useMemo(() => computePositionTotals(canonicalPositions), [canonicalPositions]);
  const openCount = useMemo(
    () => canonicalPositions.filter((p) => p.side !== 'FLAT').length,
    [canonicalPositions],
  );

  const orderRows = useMemo(() => {
    const rows = oSection?.data ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [oSection]);
  const orderCounts = useMemo(() => countOrders(orderRows), [orderRows]);

  const holdList = useMemo(() => {
    const rows = hSection?.data ?? [];
    return Array.isArray(rows) ? rows : [];
  }, [hSection]);

  const holdingsStats = useMemo(() => {
    let value = 0, mtm = 0, invested = 0;
    let sawCostBasis = false;
    for (const h of holdList) {
      const row = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
      const mv = toNum(row.value) ?? toNum(row.marketValue);
      if (mv != null) value += mv;
      const mt = toNum(row.unrealizedPnl) ?? toNum(row.pnl);
      if (mt != null) mtm += mt;
      const qty = toNum(row.quantity) ?? null;
      const avg = toNum(row.avgPrice) ?? null;
      const explicit = toNum(row.holdingCost);
      const cost = explicit ?? (qty != null && avg != null && qty > 0 && avg > 0 ? qty * avg : null);
      if (cost != null && cost > 0) { invested += cost; sawCostBasis = true; }
    }
    const investedTotal = holdList.length === 0 ? 0 : sawCostBasis ? invested : null;
    const investmentPnl = investedTotal != null ? value - investedTotal : null;
    return { value, mtm, invested: investedTotal, investmentPnl };
  }, [holdList]);

  const chargeBreakdown = useMemo(
    () => computeAggregatedCharges(orderRows),
    [orderRows],
  );

  const fundsDown = isSectionDown(fStatus);
  const positionsDown = isSectionDown(pStatus);
  const holdingsDown = isSectionDown(hStatus);
  const ordersDown = isSectionDown(oStatus);
  const loading = !loaded;

  const anySectionDown =
    (fStatus != null && fStatus !== 'ok') ||
    (pStatus != null && pStatus !== 'ok') ||
    (hStatus != null && hStatus !== 'ok') ||
    (oStatus != null && oStatus !== 'ok');

  const liveChip = (() => {
    if (!loaded && !hydrated) {
      return { dot: 'bg-muted-foreground/50 animate-pulse', label: 'Connecting…' };
    }
    if (appConnection === 'OFFLINE' && dash == null) {
      return { dot: 'bg-destructive', label: 'Offline' };
    }
    if (anySectionDown || appConnection === 'RECONNECTING' || appConnection === 'DISCONNECTED') {
      return { dot: 'bg-warning animate-pulse', label: 'Degraded' };
    }
    return { dot: 'bg-success animate-pulse', label: 'Live' };
  })();

  const lastUpdatedLabel = dash?.generatedAt ? fmtTime(dash.generatedAt) : '—';
  const lastUpdatedAge = dash?.generatedAt ? ageLabel(dash.generatedAt, serverNow) : null;

  const blockedHot = fBlocked != null && fAvailable != null && fBlocked > fAvailable;
  const heroTone: AccentTone = pnlMasked || positionsDown ? 'neutral' : pnlTone(totals.gross);

  // Session label for header
  const sessionStateLabel = String(sessionStatus ?? state.session?.mode ?? '').replace(/_/g, ' ') || (isDemo ? 'SIMULATION' : 'LIVE');
  const marketDataLabel = isDemo ? 'simulated' : 'live';
  const executionLabel = isDemo ? 'simulated' : 'live';
  const capitalLabel = isDemo ? 'virtual' : 'real';

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <div className="space-y-3 pb-4">
      {/* ---- Header — simplified per spec §4 ---- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-tight leading-none">Trading Terminal</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
            <span className="font-semibold">{terminalName}</span>
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${isDemo ? 'border-warning/30 bg-warning/10 text-warning' : 'border-success/30 bg-success/10 text-success'}`}>
              {isDemo ? 'Simulation Active' : 'Live Trading'}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Market data: {marketDataLabel} · Execution: {executionLabel} · Capital: {capitalLabel} · Session: {sessionStateLabel.toUpperCase()}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" asChild className="h-8"><Link href="/trading/trade">Trade</Link></Button>
          <Button size="sm" variant="outline" asChild className="h-8"><Link href="/trading/baskets">Basket Orders</Link></Button>
          <Button size="sm" variant="outline" asChild className="h-8"><Link href="/watchlist">Watchlist</Link></Button>
          <span className="hidden items-center gap-2 rounded-full border border-border/60 bg-card px-2.5 py-1 text-xs tabular-nums text-muted-foreground sm:flex">
            <span className={`h-1.5 w-1.5 rounded-full ${liveChip.dot}`} />
            <span className="font-medium text-foreground">{liveChip.label}</span>
            <span className="text-border">·</span>
            <span title={lastUpdatedLabel}>Updated {lastUpdatedAge ?? lastUpdatedLabel}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={refreshAll} aria-label="Refresh" disabled={fetching} className="h-8 w-8 p-0">
            <RefreshCw className={`h-4 w-4 ${fetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* ---- Engine + Market — side-by-side on large to reduce scroll, stacked on mobile ---- */}
      <div className="grid gap-3 lg:grid-cols-[380px_1fr]">
        <EngineStatusCard />
        <MarketSessionCard />
      </div>

      {/* ---- Degraded / not-connected notice — single honest row, no duplicate chips ---- */}
      {(fetchErr != null || (loaded && !dash?.enabled) || (loaded && !dash?.isLoggedIn)) && (
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-warning" />
          <p className="text-sm text-warning">
            {fetchErr != null
              ? `Unable to load trading data — ${fetchErr}.`
              : !dash?.enabled
                ? `${terminalName} is not configured. Add broker credentials, then connect.`
                : !dash?.isLoggedIn
                  ? `${terminalName} is not connected. Login from the terminal to see live data.`
                  : ''}
          </p>
          <Button size="sm" variant="outline" className="ml-auto h-7 shrink-0" onClick={refreshAll}>Retry</Button>
        </div>
      )}

      {/* ---- Today P&L hero — primary metric with restrained accent ---- */}
      <Card className={`group relative overflow-hidden border ${CARD_TONE[heroTone].border} ${CARD_TONE[heroTone].restShadow}`}>
        <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${CARD_TONE[heroTone].bar}`} />
        <CardContent className="relative grid grid-cols-1 gap-4 px-4 py-3.5 lg:grid-cols-[minmax(220px,1fr)_auto] lg:gap-8">
          <div className="flex flex-col justify-center">
            <div className="flex items-center gap-2">
              <span className={`flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset ${CARD_TONE[heroTone].icon}`}>
                {pnlMasked || positionsDown
                  ? <EyeOff className="h-4 w-4" />
                  : totals.gross >= 0
                    ? <TrendingUp className="h-4 w-4" />
                    : <TrendingDown className="h-4 w-4" />}
              </span>
              <p className="text-sm font-medium text-muted-foreground">Today Profit & Loss</p>
              <MaskToggle masked={pnlMasked} onToggle={() => setPnlMasked((m) => !m)} label="todays P&L" />
            </div>
            {loading ? (
              <Skeleton className="mt-1.5 h-8 w-44" />
            ) : (
              <p data-hero title={!pnlMasked && !positionsDown ? fmtPnl(totals.gross) : undefined} className={`mt-1 text-3xl font-semibold leading-none tracking-tight tabular-nums ${pnlMasked || positionsDown ? 'text-muted-foreground' : pnlClr(totals.gross)}`}>
                {positionsDown ? 'Data unavailable' : pnlMasked ? MASKED_AMOUNT : fmtPnl(totals.gross)}
              </p>
            )}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
              {loading ? '\u00A0' : positionsDown || pnlMasked ? (positionsDown ? 'Positions feed unavailable' : 'Reveal to view P&L detail') : (
                <>
                  <span className={`font-medium ${pnlClr(totals.pnlPct)}`}>{fmtPct(totals.pnlPct)}</span>
                  <span className="text-border">·</span>
                  <span>on {fmtRs(Math.abs(totals.exposure))} exposure</span>
                </>
              )}
            </p>
          </div>
          <div className="grid content-center grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 lg:divide-x lg:divide-border/50 lg:gap-x-0">
            <div className="lg:px-5">
              <p className="text-[11px] text-muted-foreground">Realized P&L</p>
              {loading ? <Skeleton className="mt-1 h-5 w-20" /> : <p className={`mt-1 text-sm font-semibold tabular-nums ${pnlClr(positionsDown ? null : totals.realized)}`}>{positionsDown ? 'N/A' : fmtPnl(totals.realized)}</p>}
            </div>
            <div className="lg:px-5">
              <p className="text-[11px] text-muted-foreground">Unrealized P&L</p>
              {loading ? <Skeleton className="mt-1 h-5 w-20" /> : <p className={`mt-1 text-sm font-semibold tabular-nums ${pnlClr(positionsDown ? null : totals.unrealized)}`}>{positionsDown ? 'N/A' : fmtPnl(totals.unrealized)}</p>}
            </div>
            <div className="lg:px-5">
              <p className="text-[11px] text-muted-foreground">Net P&L (after charges)</p>
              {loading ? <Skeleton className="mt-1 h-5 w-20" /> : <p className={`mt-1 text-sm font-semibold tabular-nums ${pnlClr(positionsDown ? null : totals.net)}`}>{positionsDown ? 'N/A' : fmtPnl(totals.net)}</p>}
            </div>
            <div className="lg:pl-5">
              <p className="text-[11px] text-muted-foreground">Last update</p>
              <p className="mt-1 text-sm font-medium tabular-nums">{lastUpdatedLabel}</p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={`h-1.5 w-1.5 rounded-full ${liveChip.dot}`} />{liveChip.label}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Broker Terminals — shared 4-card grid ---- */}
      <BrokerCardsSection reloadKey={fetching ? 1 : 0} />

      {/* ---- Session · Alerts · Broker Health ---- */}
      <TradingOpsRow />

      {/* ---- ACCOUNT & CAPITAL — hierarchical dominant panel ---- */}
      <section aria-label="Account and capital" className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <SectionHeading>Account & Capital</SectionHeading>
          <SectionStatus status={fStatus} timestamp={fSection?.timestamp} now={serverNow} />
        </div>

        {/* Dominant panel + Exposure side-by-side */}
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          {/* Primary: Available Balance dominant */}
          <Card className="overflow-hidden border-border/60">
            <CardContent className="px-4 py-3.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Available Balance</h3>
                <Wallet className="h-3.5 w-3.5 text-muted-foreground/60" />
              </div>
              {loading ? (
                <Skeleton className="mt-2 h-8 w-48" />
              ) : fundsDown ? (
                <p className="mt-2 text-sm font-medium text-muted-foreground">Data unavailable</p>
              ) : (
                <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{fmtRs(fAvailable ?? totalMargin)}</p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11px] text-muted-foreground">Free Margin</p>
                  {loading ? <Skeleton className="mt-1 h-5 w-24" /> : <p className="mt-0.5 text-sm font-semibold tabular-nums">{fundsDown ? '—' : fmtRs(fAvailable)}</p>}
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Used Margin</p>
                  {loading ? <Skeleton className="mt-1 h-5 w-24" /> : <p className="mt-0.5 text-sm font-semibold tabular-nums">{fundsDown ? '—' : fmtRs(fUsed)}</p>}
                </div>
              </div>
              {/* Utilization bar */}
              <div className="mt-3">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Margin Utilization</span>
                  <span className="font-medium tabular-nums">{utilization == null ? '—' : `${utilization.toFixed(1)}%`}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${utilization ?? 0}%` }} />
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2.5 text-xs">
                <span className="text-muted-foreground">Charges (today)</span>
                <span className="font-medium tabular-nums">{fundsDown ? '—' : fmtRs(chargeBreakdown.totalCharges)}</span>
              </div>
            </CardContent>
          </Card>

          {/* Secondary: Exposure & P&L compact */}
          <Card className="overflow-hidden border-border/60">
            <CardContent className="px-4 py-3.5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exposure & P&L</h3>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                <div>
                  <p className="text-[11px] text-muted-foreground">Invested</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums">{fundsDown ? '—' : holdingsStats.invested == null ? '—' : investmentMasked ? MASKED_AMOUNT : fmtRs(holdingsStats.invested)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Current Value</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums">{fundsDown ? '—' : fmtRs(holdingsStats.value)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Exposure</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums">{positionsDown ? '—' : fmtRs(Math.abs(totals.exposure))}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Unrealized P&L</p>
                  <p className={`mt-0.5 text-sm font-semibold tabular-nums ${pnlClr(positionsDown ? null : totals.unrealized)}`}>{positionsDown ? '—' : fmtPnl(totals.unrealized)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Realized P&L</p>
                  <p className={`mt-0.5 text-sm font-semibold tabular-nums ${pnlClr(positionsDown ? null : totals.realized)}`}>{positionsDown ? '—' : fmtPnl(totals.realized)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Total P&L</p>
                  <p className={`mt-0.5 text-sm font-semibold tabular-nums ${pnlClr(positionsDown ? null : totals.gross)}`}>{positionsDown ? '—' : fmtPnl(totals.gross)}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-border/50 pt-2.5">
                <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" asChild><Link href="/market-calendar">Market Calendar</Link></Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tertiary: small supplementary funds */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            icon={CreditCard} tone={fundsDown ? 'neutral' : blockedHot ? 'danger' : 'neutral'}
            dataVerify="blocked-margin" title="Blocked Margin"
            value={fundsDown ? null : fmtRs(fBlocked)} unavailable={fundsDown}
            sub={blockedHot ? 'Exceeds available' : 'Collateral/blocked'}
            loading={loading} stale={isSectionDown(fStatus)}
          />
          <MetricCard
            icon={IndianRupee} tone="neutral"
            dataVerify="cash" title="Cash"
            value={fundsDown ? null : fmtRs(fCash)} unavailable={fundsDown}
            sub="Cash component"
            loading={loading} stale={isSectionDown(fStatus)}
          />
          <MetricCard
            icon={PiggyBank} tone="neutral"
            dataVerify="collateral" title="Collateral"
            value={fundsDown ? null : fmtRs(fCollateral)} unavailable={fundsDown}
            sub="Pledged value"
            loading={loading} stale={isSectionDown(fStatus)}
          />
          <MetricCard
            icon={Wallet} tone="neutral"
            dataVerify="total-balance" title="Total Balance"
            value={fundsDown ? null : fmtRs(totalMargin)} unavailable={fundsDown}
            sub="Available + Used"
            loading={loading} stale={isSectionDown(fStatus)}
          />
        </div>
      </section>

      {/* ---- ORDERS — compact 6 across, restrained tones ---- */}
      <section aria-label="Orders" className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <SectionHeading>Orders</SectionHeading>
          <SectionStatus status={oStatus} timestamp={oSection?.timestamp} now={serverNow} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <MetricCard
            icon={ShoppingCart} tone={ordersDown ? 'neutral' : 'neutral'}
            dataVerify="total-orders" title="Total Orders"
            value={ordersDown ? null : String(orderCounts.total)} unavailable={ordersDown}
            sub="Order book"
            loading={loading} stale={isSectionDown(oStatus)}
          />
          <MetricCard
            icon={CheckCircle2} tone={ordersDown || orderCounts.executed === 0 ? 'neutral' : 'success'}
            dataVerify="executed-orders" title="Executed"
            value={ordersDown ? null : String(orderCounts.executed)} unavailable={ordersDown}
            sub="Filled · partial"
            loading={loading} stale={isSectionDown(oStatus)}
          />
          <MetricCard
            icon={Clock} tone={ordersDown || orderCounts.pending === 0 ? 'neutral' : 'warning'}
            dataVerify="pending-orders" title="Pending"
            value={ordersDown ? null : String(orderCounts.pending)} unavailable={ordersDown}
            sub="Awaiting"
            loading={loading} stale={isSectionDown(oStatus)}
          />
          <MetricCard
            icon={AlertCircle} tone={ordersDown || orderCounts.rejected === 0 ? 'neutral' : 'danger'}
            dataVerify="rejected-orders" title="Rejected"
            value={ordersDown ? null : String(orderCounts.rejected)} unavailable={ordersDown}
            sub="By broker/RMS"
            loading={loading} stale={isSectionDown(oStatus)}
          />
          <MetricCard
            icon={Archive} tone="neutral"
            dataVerify="cancelled-orders" title="Cancelled"
            value={ordersDown ? null : String(orderCounts.cancelled)} unavailable={ordersDown}
            sub="Cancelled · expired"
            loading={loading} stale={isSectionDown(oStatus)}
          />
          <MetricCard
            icon={Receipt} tone="neutral"
            dataVerify="order-charges" title="Order Charges"
            value={ordersDown ? null : fmtRs(chargeBreakdown.totalCharges)} unavailable={ordersDown}
            sub={chargeBreakdown.confirmed ? 'Broker-reported' : 'Estimated'}
            loading={loading} stale={isSectionDown(oStatus)}
          />
        </div>
      </section>

      {/* ---- POSITIONS — compact ---- */}
      <section aria-label="Positions" className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <SectionHeading>Positions</SectionHeading>
          <SectionStatus status={pStatus} timestamp={pSection?.timestamp} now={serverNow} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <MetricCard
            icon={Briefcase} tone={positionsDown || openCount === 0 ? 'neutral' : 'neutral'}
            dataVerify="open-positions" title="Open Positions"
            value={positionsDown ? null : String(openCount)} unavailable={positionsDown}
            sub={`${totals.longCount} Long · ${totals.shortCount} Short`}
            loading={loading} stale={isSectionDown(pStatus)}
          />
          <MetricCard
            icon={Archive} tone="neutral"
            dataVerify="closed-positions" title="Closed"
            value={positionsDown ? null : String(totals.closedCount)} unavailable={positionsDown}
            sub="Squared off today"
            loading={loading} stale={isSectionDown(pStatus)}
          />
          <MetricCard
            icon={Layers} tone="neutral"
            dataVerify="total-qty" title="Total Qty"
            value={positionsDown ? null : fmtQty(totals.longQty + totals.shortQty)} unavailable={positionsDown}
            sub={`Long ${fmtQty(totals.longQty)} · Short ${fmtQty(totals.shortQty)}`}
            loading={loading} stale={isSectionDown(pStatus)}
          />
          <MetricCard
            icon={TrendingUp} tone="neutral"
            dataVerify="long-qty" title="Long Qty"
            value={positionsDown ? null : fmtQty(totals.longQty)} unavailable={positionsDown}
            sub={`${totals.longCount} longs`}
            loading={loading} stale={isSectionDown(pStatus)}
          />
          <MetricCard
            icon={TrendingDown} tone="neutral"
            dataVerify="short-qty" title="Short Qty"
            value={positionsDown ? null : fmtQty(totals.shortQty)} unavailable={positionsDown}
            sub={`${totals.shortCount} shorts`}
            loading={loading} stale={isSectionDown(pStatus)}
          />
          <MetricCard
            icon={Activity} tone="neutral"
            dataVerify="exposure" title="Exposure"
            value={positionsDown ? null : fmtRs(Math.abs(totals.exposure))} unavailable={positionsDown}
            sub={`Market value ${fmtRs(totals.openMarketValue)}`}
            loading={loading} stale={isSectionDown(pStatus)}
          />
        </div>
      </section>

      <TopPositions rows={pSection?.data ?? []} down={positionsDown} loading={loading} />

      <TradingActivitySection orderRows={orderRows} totals={totals} down={ordersDown || positionsDown} loading={loading} />

      {/* ---- HOLDINGS — 5 cards (total investment masked) ---- */}
      <section aria-label="Investment and holdings" className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <SectionHeading>Investment / Holdings</SectionHeading>
          <SectionStatus status={hStatus} timestamp={hSection?.timestamp} now={serverNow} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <MetricCard
            icon={PiggyBank} tone={investmentMasked || holdingsDown || holdingsStats.invested == null ? 'neutral' : 'neutral'}
            dataVerify="total-investment" title="Total Investment"
            value={
              holdingsDown ? null
                : holdingsStats.invested == null ? null
                  : investmentMasked ? MASKED_AMOUNT : fmtRs(holdingsStats.invested)
            }
            unavailable={holdingsDown}
            sub="Cost basis"
            valueClass={investmentMasked ? 'text-muted-foreground' : undefined}
            loading={loading} stale={isSectionDown(hStatus)}
            action={
              holdingsStats.invested != null && !holdingsDown && !loading ? (
                <MaskToggle masked={investmentMasked} onToggle={() => setInvestmentMasked((m) => !m)} label="total investment" />
              ) : undefined
            }
          />
          <MetricCard
            icon={PieChart} tone="neutral"
            dataVerify="holdings-value" title="Holdings Value"
            value={holdingsDown ? null : fmtRs(holdingsStats.value)} unavailable={holdingsDown}
            sub={`${holdList.length} scrips · market value`}
            loading={loading} stale={isSectionDown(hStatus)}
          />
          <MetricCard
            icon={Briefcase} tone="neutral"
            dataVerify="holdings-count" title="Holdings Count"
            value={holdingsDown ? null : String(holdList.length)} unavailable={holdingsDown}
            sub="Unique scrips"
            loading={loading} stale={isSectionDown(hStatus)}
          />
          <MetricCard
            icon={TrendingUp} tone={holdingsDown || holdingsStats.investmentPnl == null ? 'neutral' : pnlTone(holdingsStats.investmentPnl)}
            dataVerify="investment-pnl" title="Investment P&L"
            value={holdingsDown ? null : holdingsStats.investmentPnl == null ? null : fmtPnl(holdingsStats.investmentPnl)} unavailable={holdingsDown}
            sub="Value − cost"
            valueClass={pnlClr(holdingsStats.investmentPnl)}
            loading={loading} stale={isSectionDown(hStatus)}
          />
          <MetricCard
            icon={Activity} tone={holdingsDown ? 'neutral' : pnlTone(holdingsStats.mtm)}
            dataVerify="unrealized-holdings" title="Unrealized P&L"
            value={holdingsDown ? null : fmtPnl(holdingsStats.mtm)} unavailable={holdingsDown}
            sub="Unrealized"
            valueClass={pnlClr(holdingsStats.mtm)}
            loading={loading} stale={isSectionDown(hStatus)}
          />
        </div>
      </section>

      <LiveMarketWatchSection />

      <RecentOrdersSection rows={orderRows} down={ordersDown} loading={loading} />

      {/* ---- Targets & quick actions — compact row ---- */}
      <section aria-label="Quick actions" className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild><Link href="/alerts"><Target className="mr-1 h-3.5 w-3.5" /> View Alerts</Link></Button>
        <Button size="sm" variant="outline" asChild><Link href="/market-calendar"><CalendarClock className="mr-1 h-3.5 w-3.5" /> Market Calendar</Link></Button>
      </section>

      <p className="pt-2 text-center text-[11px] text-muted-foreground">
        Last updated {lastUpdatedLabel} · {fmtTime(new Date(serverNow).toISOString())} IST · Backend {isDemo ? 'SIMULATION' : 'LIVE'} · Nothing is fabricated — empty means no data.
      </p>
    </div>
  );
}
