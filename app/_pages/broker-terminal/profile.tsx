'use client';

/**
 * SERVICES -> Trading -> Broker Terminal -> Broker Profile
 *
 * Full-page profile for ONE broker terminal (or the Combined aggregate). Views
 * the SAME honest engine snapshot as the overview (GET /api/trading/brokers/
 * overview) section-by-section: identity/session, funds & margin, P&L, then —
 * ONLY when this broker is the active terminal — the live ledger tables
 * (positions / holdings / orders) from GET /api/trading/dashboard. A broker
 * that is not active shows the engine's real aggregate counts (positions,
 * long/short qty, open orders) plus an honest "switch terminal" note instead
 * of silently fabricating a ledger. "Total balance" falls back to the
 * available margin when the feed omits a balance field.
 *
 * DESIGN: a per-broker hero tinted with that broker's own colour (so Kotak is
 * always blue and Shoonya always orange, everywhere in the app) carrying a
 * margin-utilisation ring, position bar and order-lifecycle bar. Machine
 * tokens are resolved to proper names via `broker-shared`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Gauge,
  KeyRound,
  Landmark,
  Layers,
  LineChart,
  ListChecks,
  PlugZap,
  RefreshCw,
  Settings2,
  ShoppingBag,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  EmptyState,
  ErrorState,
  LiveIndicator,
  SectionHeading,
  StatusBadge,
  type AccentTone,
} from '@/components/design-system';
import {
  ACCENT_TEXT,
  InfoRow,
  MiniCard,
  SectionCardHead,
  SectionShell,
  SystemStatusStrip,
  TERMINAL_META,
  maskId,
  orderBadge,
  orderStateName,
  pickNum,
  pickStr,
  pnlToneValue,
  sessionBadge,
  sessionManagerTs,
  sessionStateName,
  terminalHue,
} from '@/components/broker-terminal/broker-shared';
import {
  BrokerHero,
  LiveDot,
  OrderLifecycleBar,
  PositionBar,
  RingGauge,
  heroAccent,
  marginTone,
} from '@/components/broker-terminal/broker-visual';
import {
  getBrokersStatus,
  getBrokerTerminalOverview,
  getSessionManagerSession,
  getTradingDashboard,
  refreshBrokerOverview,
  type TradingDashboardResponse,
} from '@/lib/api';
import { useBackend } from '@/lib/use-backend';
import { ageLabel, useServerNow } from '@/lib/time-engine';
import { fmtPnl, fmtQty, fmtRs, toNum } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { useRealtime } from '@/components/realtime-provider';

const price = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function DataTable({ cols, head, rows, cell, emptyText, icon }: {
  cols: string;
  head: React.ReactNode[];
  rows: any[];
  cell: (r: any) => React.ReactNode[];
  emptyText: string;
  icon?: React.ElementType;
}) {
  if (!rows || rows.length === 0) {
    return <EmptyState icon={icon ?? ListChecks} title={emptyText} description="Honest zero — the feed returned no rows." className="py-8" />;
  }
  return (
    <div className="cm-scroll overflow-x-auto">
      <div className="min-w-[640px]">
        <div className={cn('grid items-center gap-3 rounded-t-lg border border-b-0 border-border/60 bg-muted/40 px-3 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground', cols)}>
          {head.map((h, i) => <span key={i} className="truncate">{h}</span>)}
        </div>
        <div className="divide-y divide-border/60 rounded-b-lg border border-border/60">
          {rows.map((r, i) => (
            <div key={i} className={cn('grid items-center gap-3 px-3 py-2 text-xs tabular-nums transition-colors hover:bg-muted/25', cols)}>
              {cell(r).map((c, j) => <span key={j} className="truncate">{c}</span>)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// HERO
// ===========================================================================

function ProfileHero({ term, row, meta, activeTerm, loading, now, generatedAt, funds }: {
  term: string;
  row: Record<string, any> | undefined;
  meta: { name: string; sub: string; icon: React.ElementType; tone: AccentTone; kind: string };
  activeTerm: string | null | undefined;
  loading: boolean;
  now: number;
  generatedAt?: string;
  funds: Record<string, any> | null | undefined;
}) {
  const Icon = meta.icon;
  const enabled = row?.enabled !== false;
  const isActive = term !== 'combined' && activeTerm === term;
  const hue = terminalHue(term);

  const balance = toNum(row?.balance) ?? toNum(row?.availableMargin);
  const used = toNum(row?.usedMargin);
  const avail = toNum(row?.availableMargin);
  const cash = toNum(row?.cash) ?? toNum(funds?.cash);
  const blocked = toNum(row?.blockedMargin) ?? toNum(funds?.blockedMargin);
  const exposure = toNum(row?.exposure);
  const invested = toNum(row?.invested);
  const currentValue = toNum(row?.currentValue) ?? toNum(funds?.currentValue);
  const pnl = toNum(row?.totalPnl);
  const realized = toNum(row?.realizedPnl);
  const unrealized = toNum(row?.unrealizedPnl);
  const orders = row?.orders ?? {};
  const longQty = toNum(row?.longQty);
  const shortQty = toNum(row?.shortQty);

  const utilPct = used != null && avail != null && avail > 0 ? Math.round((used / avail) * 1000) / 10 : null;
  const badge = row ? sessionBadge(row?.sessionState, row?.connected) : { status: 'neutral' as const, label: 'LOADING' };
  const proper = sessionStateName(row?.sessionState);

  const heroTone = !enabled ? 'warning' : badge.status === 'success' ? 'success' : row ? 'danger' : 'neutral';

  return (
    <BrokerHero accent={heroAccent(heroTone)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1"
            style={{ background: `${hue}22`, color: hue, borderColor: `${hue}55` }}
          >
            <Icon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xl font-bold tracking-display">{meta.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{meta.sub} · {meta.kind}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {isActive ? <Badge className="border-primary/40 bg-primary/15 text-primary">ACTIVE TERMINAL</Badge> : null}
          {!enabled ? <StatusBadge status="warning" label="NOT CONFIGURED" /> : null}
          <StatusBadge status={badge.status} label={badge.label} />
          {term === 'combined' ? <Badge variant="outline">Kotak + Shoonya only</Badge> : null}
        </div>
      </div>

      {proper?.blurb ? (
        <p className="mt-2 text-[10px] italic text-muted-foreground">{proper.blurb}</p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total balance</p>
          <p className={cn('truncate text-3xl font-bold tracking-display tabular-nums sm:text-4xl', balance == null && 'text-lg font-medium text-muted-foreground')}>
            {loading ? '…' : balance == null ? 'N/A' : fmtRs(balance)}
          </p>
        </div>

        <div className="flex items-center gap-5">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total P&amp;L</p>
            <p className={cn('truncate text-xl font-bold tabular-nums', ACCENT_TEXT[pnlToneValue(pnl)])}>
              {loading ? '…' : fmtPnl(pnl)}
            </p>
            <p className="truncate text-[10px] tabular-nums text-muted-foreground">
              R {loading ? '…' : fmtPnl(realized)} · UR {loading ? '…' : fmtPnl(unrealized)}
            </p>
          </div>
          <RingGauge value={utilPct} max={100} label="margin used" tone={marginTone(utilPct)} live={isActive} size={104} thickness={8} />
        </div>
      </div>

      {/* Position + order bars */}
      <div className="mt-5 grid gap-4 border-t border-border/40 pt-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Long / short</span>
            <span className="font-mono tabular-nums">{fmtQty(longQty ?? 0)} / {fmtQty(shortQty ?? 0)}</span>
          </div>
          <PositionBar long={longQty} short={shortQty} />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Orders</span>
            <span className="font-mono tabular-nums">{orders?.total ?? '—'} total</span>
          </div>
          <OrderLifecycleBar orders={orders} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <MiniCard label="Used margin" value={loading ? '…' : fmtRs(used)} tone={used != null && avail != null && used > avail ? 'danger' : 'neutral'} />
        <MiniCard label="Available margin" value={loading ? '…' : fmtRs(avail)} tone="success" />
        <MiniCard label="Cash" value={loading ? '…' : fmtRs(cash)} />
        <MiniCard label="Blocked margin" value={loading ? '…' : fmtRs(blocked)} />
        <MiniCard label="Exposure" value={loading ? '…' : fmtRs(exposure)} />
        <MiniCard label="Invested" value={loading ? '…' : fmtRs(invested)} />
        <MiniCard label="Current value" value={loading ? '…' : fmtRs(currentValue)} />
        <MiniCard label="Realized P&L" value={loading ? '…' : fmtPnl(realized)} tone={pnlToneValue(realized)} />
        <MiniCard label="Unrealized P&L" value={loading ? '…' : fmtPnl(unrealized)} tone={pnlToneValue(unrealized)} />
        <MiniCard label="Open positions" value={loading ? '…' : row?.positionCount == null ? '—' : String(row.positionCount)} />
        <MiniCard label="Open orders" value={loading ? '…' : orders?.open == null ? '—' : `${orders.open} open · ${orders.pending ?? 0} pending`} />
        <MiniCard label="Last sync" value={loading ? '…' : ageLabel(generatedAt ?? row?.updatedAt, now) ?? '—'} />
      </div>

      {row?.message || row?.lastError ? (
        <p className={cn('mt-3 rounded-md border px-2.5 py-1.5 text-[11px]', row.lastError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border/60 text-muted-foreground')}>
          {row.lastError ?? row.message}
        </p>
      ) : null}
    </BrokerHero>
  );
}

// ===========================================================================
// IDENTITY & SESSION
// ===========================================================================

function IdentitySessionCard({ term, row, session, now, combinedMode }: {
  term: string;
  row: Record<string, any> | undefined;
  session: any;
  now: number;
  combinedMode: boolean;
}) {
  const sm = session?.data ?? session;
  const identity = sm?.identity ?? {};
  const lifecycle = sm?.lifecycle ?? {};
  const state = lifecycle?.state ?? identity?.state ?? row?.sessionState;
  const enabled = row?.enabled !== false;
  const connected = Boolean(row?.connected);
  const badge = sessionBadge(String(state ?? ''), connected);
  const proper = sessionStateName(String(state ?? ''));
  const hue = terminalHue(term);

  return (
    <SectionShell>
      <SectionCardHead icon={KeyRound} title="Identity & Session" tone="violet" />
      <div className="space-y-0.5">
        <InfoRow label="Terminal" value={term === 'combined' ? 'Combined' : row?.name ?? TERMINAL_META[term]?.name ?? term} />
        <InfoRow label="Kind" value={combinedMode ? 'Capital aggregate' : TERMINAL_META[term]?.kind ?? 'Broker terminal'} />
        <InfoRow label="Configured" value={enabled ? 'yes' : 'no'} />
        <InfoRow label="Active terminal" value={combinedMode ? '— (aggregate)' : row?.active ? 'yes · trade here' : 'no'} />
        <InfoRow label="Login state" value={<StatusBadge status={badge.status} label={badge.label} />} />
        {proper?.blurb ? (
          <p className="pb-1 text-[10px] italic leading-snug text-muted-foreground">{proper.blurb}</p>
        ) : null}
        <InfoRow label="Session ID" value={<span className="font-mono">{maskId(identity?.sessionId)}</span>} mono />
        <InfoRow label="WS state" value={String(row?.sessionState ?? identity?.state ?? '—')} />
        <InfoRow label="Scheduled refresh" value={ageLabel(row?.updatedAt, now) ?? '—'} />
        <InfoRow label="Last event" value={sessionManagerTs(identity?.loginTime)} />
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hue }} />
        <span className="text-[10px] text-muted-foreground">
          Identities come from the session manager; balances from the broker adapter.
        </span>
      </div>
      {combinedMode && (
        <p className="mt-2 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
          Aggregate = Kotak Neo + Shoonya. Dummy's virtual capital is excluded so the combined number stays real money.
        </p>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// FUNDS & MARGIN
// ===========================================================================

function FundsMarginCard({ row, funds, dashSection, combinedMode }: {
  row: Record<string, any> | undefined;
  funds: Record<string, any> | null | undefined;
  dashSection: any;
  combinedMode: boolean;
}) {
  const active = dashSection?.status === 'ok';
  const preferred = active && dashSection?.data ? dashSection.data : funds ?? row;
  const balance = toNum(preferred?.balance) ?? toNum(row?.balance) ?? toNum(row?.availableMargin);
  const used = toNum(preferred?.usedMargin) ?? toNum(row?.usedMargin);
  const avail = toNum(preferred?.freeMargin ?? preferred?.availableMargin) ?? toNum(row?.availableMargin);
  const cash = toNum(preferred?.cash);
  const blocked = toNum(preferred?.blockedMargin);
  const pnl = toNum(preferred?.totalPnl);
  const realized = toNum(preferred?.realizedPnl) ?? toNum(row?.realizedPnl);
  const unrealized = toNum(preferred?.unrealizedPnl) ?? toNum(row?.unrealizedPnl);
  const pct = used != null && avail != null && avail > 0 ? Math.round((used / avail) * 1000) / 10 : null;
  const free = pct == null ? null : Math.max(0, 100 - pct);

  return (
    <SectionShell>
      <SectionCardHead
        icon={Landmark}
        title="Funds & Margin"
        tone="blue"
        right={active ? <Badge variant="outline">live ledger</Badge> : combinedMode ? <Badge variant="outline">aggregate</Badge> : <Badge variant="outline">engine</Badge>}
      />
      <div className="flex flex-wrap items-center gap-4">
        <RingGauge value={pct} max={100} label="margin used" tone={marginTone(pct)} size={112} thickness={8} />
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniCard label="Total balance" value={balance == null ? 'N/A' : fmtRs(balance)} valueClass={balance == null ? 'text-muted-foreground' : 'text-base'} />
            <MiniCard label="Available margin" value={fmtRs(avail)} tone="success" />
            <MiniCard label="Used margin" value={fmtRs(used)} tone={pct != null && pct > 100 ? 'danger' : 'neutral'} />
            <MiniCard label="Margin util." value={pct == null ? '—' : `${pct}%`} tone={marginTone(pct) === 'neutral' ? 'neutral' : marginTone(pct)} />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniCard label="Cash" value={fmtRs(cash)} />
            <MiniCard label="Blocked margin" value={fmtRs(blocked)} />
            <MiniCard label="Exposure" value={fmtRs(toNum(row?.exposure))} />
            <MiniCard label="Invested" value={fmtRs(toNum(row?.invested))} />
            <MiniCard label="Current value" value={fmtRs(toNum(row?.currentValue))} />
            <MiniCard label="Total P&L" value={fmtPnl(pnl)} tone={pnlToneValue(pnl)} />
            <MiniCard label="Realized P&L" value={fmtPnl(realized)} tone={pnlToneValue(realized)} />
            <MiniCard label="Unrealized P&L" value={fmtPnl(unrealized)} tone={pnlToneValue(unrealized)} />
          </div>
          {free != null ? (
            <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
              {free.toFixed(1)}% of the margin line still free.
            </p>
          ) : null}
        </div>
      </div>
      {pct != null && pct > 100 && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] font-medium text-destructive">
          Margin utilisation above 100% — this broker is over the line.
        </p>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// LEDGER TABLES
// ===========================================================================

function PositionsTable({ dash }: { dash: TradingDashboardResponse | null }) {
  const sec = dash?.sections?.positions;
  const rows: any[] = sec?.data ?? [];
  return (
    <SectionShell>
      <SectionCardHead icon={LineChart} title="Positions" tone="success" right={sec?.status === 'ok' ? <Badge variant="outline">{rows.length} open</Badge> : null} />
      {sec?.status !== 'ok' ? (
        <p className="text-xs text-muted-foreground">Positions feed not attached: {sec?.status ?? 'unavailable'}{sec?.error ? ` — ${sec.error}` : ''}</p>
      ) : (
        <DataTable
          cols="grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]"
          head={['Symbol', 'BUY qty', 'SELL qty', 'Avg', 'LTP', 'Unrealized P&L']}
          rows={rows}
          emptyText="No open positions" icon={LineChart}
          cell={(r) => {
            const pnl = pickNum(r, ['unrealizedPnl', 'unrealisedPnl', 'unrealised_pnl', 'pnl', 'pnl_amount']);
            return [
              <span key="s" className="font-medium">{pickStr(r, ['symbol', 'tradingSymbol', 'trading_symbol', 'instrument'])}</span>,
              fmtQty(pickNum(r, ['buyQuantity', 'buy_qty', 'buyQty']) ?? 0),
              <span key="sq" className="text-destructive">{fmtQty(pickNum(r, ['sellQuantity', 'sell_qty', 'sellQty']) ?? 0)}</span>,
              price(pickNum(r, ['averagePrice', 'avgPrice', 'avg_prc', 'avg_price'])),
              price(pickNum(r, ['ltp', 'lastPrice', 'last_price', 'closePrice', 'closingPrice'])),
              <span key="u" className={cn('font-medium', ACCENT_TEXT[pnlToneValue(pnl)])}>{fmtPnl(pnl)}</span>,
            ];
          }}
        />
      )}
    </SectionShell>
  );
}

function HoldingsTable({ dash }: { dash: TradingDashboardResponse | null }) {
  const sec = dash?.sections?.holdings;
  const rows: any[] = sec?.data ?? [];
  return (
    <SectionShell>
      <SectionCardHead icon={Wallet} title="Holdings" tone="cyan" right={sec?.status === 'ok' ? <Badge variant="outline">{rows.length}</Badge> : null} />
      {sec?.status !== 'ok' ? (
        <p className="text-xs text-muted-foreground">Holdings feed not attached: {sec?.status ?? 'unavailable'}{sec?.error ? ` — ${sec.error}` : ''}</p>
      ) : (
        <DataTable
          cols="grid-cols-[2fr_1fr_1fr_1fr_1fr]"
          head={['Symbol', 'Qty', 'Avg', 'LTP', 'Current value']}
          rows={rows}
          emptyText="No holdings" icon={Wallet}
          cell={(r) => {
            const qty = pickNum(r, ['holdingQuantity', 'quantity', 'qty', 'holdQty']) ?? 0;
            const avg = pickNum(r, ['averagePrice', 'avgPrice', 'avg_prc', 'avg_price']);
            const ltp = pickNum(r, ['ltp', 'lastPrice', 'last_price', 'closePrice']);
            const value = qty * (ltp ?? avg ?? 0);
            const cost = qty * (avg ?? 0);
            return [
              <span key="s" className="font-medium">{pickStr(r, ['symbol', 'tradingSymbol', 'trading_symbol', 'instrument'])}</span>,
              fmtQty(qty),
              price(avg),
              price(ltp),
              <span key="v">
                {avg != null || ltp != null ? fmtRs(ltp != null ? value : cost) : '—'}
                {ltp != null && avg != null ? (
                  <span className={cn('ml-1.5 text-[9px]', ACCENT_TEXT[pnlToneValue(value - cost)])}>
                    {fmtPnl(value - cost)}
                  </span>
                ) : null}
              </span>,
            ];
          }}
        />
      )}
    </SectionShell>
  );
}

function OrdersTable({ dash }: { dash: TradingDashboardResponse | null }) {
  const sec = dash?.sections?.orders;
  const rows: any[] = sec?.data ?? [];
  return (
    <SectionShell>
      <SectionCardHead icon={ShoppingBag} title="Orders" tone="warning" right={sec?.status === 'ok' ? <Badge variant="outline">{rows.length} shown</Badge> : null} />
      {sec?.status !== 'ok' ? (
        <p className="text-xs text-muted-foreground">Orders feed not attached: {sec?.status ?? 'unavailable'}{sec?.error ? ` — ${sec.error}` : ''}</p>
      ) : (
        <DataTable
          cols="grid-cols-[1.2fr_2fr_0.8fr_0.8fr_0.8fr_1fr_1fr_1.4fr]"
          head={['Order', 'Symbol', 'Side', 'Qty', 'Filled', 'Price', 'Avg', 'Status']}
          rows={rows}
          emptyText="No orders" icon={ShoppingBag}
          cell={(r) => {
            const side = pickStr(r, ['transactionType', 'side', 'transaction_type', 'txnType']);
            const status = pickStr(r, ['status', 'orderStatus', 'ord_status']);
            const badge = orderBadge(status);
            const proper = orderStateName(status);
            const qty = pickNum(r, ['quantity', 'qty']) ?? 0;
            const filled = pickNum(r, ['filledQuantity', 'filledQty', 'filled_quantity']) ?? 0;
            return [
              <span key="o" className="font-mono text-[11px]">{pickStr(r, ['orderId', 'order_id', 'orderRef', 'norenOrderNo', 'id'])}</span>,
              <span key="s" className="font-medium">{pickStr(r, ['symbol', 'tradingSymbol', 'trading_symbol', 'instrument'])}</span>,
              <span key="sd" className={cn('font-medium capitalize', /SELL|S/i.test(side) ? 'text-destructive' : 'text-success')}>{side}</span>,
              fmtQty(qty),
              <span key="f" className={filled > 0 && filled < qty ? 'text-warning' : ''}>{fmtQty(filled)}</span>,
              price(pickNum(r, ['price'])),
              price(pickNum(r, ['averagePrice', 'avgPrice', 'avg_prc', 'avg_price'])),
              <span key="st" title={proper?.blurb}>
                <StatusBadge status={badge.status} label={badge.label} />
              </span>,
            ];
          }}
        />
      )}
    </SectionShell>
  );
}

function LedgerUnavailable({ meta, row, activeTerm }: {
  meta: { name: string; sub: string; icon: React.ElementType };
  row: Record<string, any> | undefined;
  activeTerm: string | null | undefined;
}) {
  const pos = toNum(row?.positionCount);
  const activeName = activeTerm ? (TERMINAL_META[activeTerm]?.name ?? activeTerm) : null;
  return (
    <SectionShell className="border-dashed">
      <SectionCardHead icon={LineChart} title="Positions · Holdings · Orders" tone="neutral" />
      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">{meta.name}</span> is not the active trading terminal
        {activeName ? <> — <span className="capitalize">{activeName}</span> is</> : ' — no terminal is currently active'}, so the live
        ledger endpoint only attaches to the active broker. The engine still aggregates this broker's snapshot:
      </p>
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>Long / short</span>
          <span className="font-mono tabular-nums">{fmtQty(toNum(row?.longQty) ?? 0)} / {fmtQty(toNum(row?.shortQty) ?? 0)}</span>
        </div>
        <PositionBar long={toNum(row?.longQty)} short={toNum(row?.shortQty)} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MiniCard label="Open positions" value={pos == null ? '—' : String(pos)} />
        <MiniCard label="Long qty" value={fmtQty(toNum(row?.longQty) ?? 0)} />
        <MiniCard label="Short qty" value={fmtQty(toNum(row?.shortQty) ?? 0)} />
        <MiniCard label="Open orders" value={row?.orders?.open == null ? '—' : String(row.orders.open)} />
      </div>
      <div className="mt-3">
        <Button variant="outline" size="sm" asChild><Link href="/services/broker-terminal/terminals">Switch active terminal</Link></Button>
      </div>
    </SectionShell>
  );
}

function CombinedBrokerBreakdown({ terminals, combined }: { terminals: Record<string, any>; combined: Record<string, any> | undefined }) {
  const parts = (['kotak', 'shoonya'] as const).map((id) => terminals[id]).filter(Boolean);
  return (
    <SectionShell>
      <SectionCardHead icon={Layers} title="Per-broker breakdown" tone="purple" />
      <DataTable
        cols="grid-cols-[1.4fr_1fr_1fr_1fr_1fr_1fr]"
        head={['Broker', 'Balance', 'Used', 'Available', 'Invested', 'P&L']}
        rows={parts}
        emptyText="No broker funds" icon={Layers}
        cell={(r) => {
          const bal = toNum(r?.balance) ?? toNum(r?.availableMargin);
          const pnl = toNum(r?.totalPnl);
          return [
            <span key="n" className="flex items-center gap-1.5 font-medium">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: terminalHue(r?.id) }} />
              {TERMINAL_META[r?.id]?.name ?? r?.id}
            </span>,
            bal == null ? 'N/A' : fmtRs(bal),
            fmtRs(toNum(r?.usedMargin)),
            fmtRs(toNum(r?.availableMargin)),
            fmtRs(toNum(r?.invested)),
            <span key="p" className={cn('font-medium', ACCENT_TEXT[pnlToneValue(pnl)])}>{fmtPnl(pnl)}</span>,
          ];
        }}
      />
      <p className="mt-2 text-[10px] text-muted-foreground">
        {combined?.balance != null ? `Aggregate total: ${fmtRs(combined.balance)}` : 'Aggregate unavailable'}
        {' · '}excludes Dummy's virtual capital.
      </p>
    </SectionShell>
  );
}

function HealthCard({ status, term }: { status: Record<string, any> | null; term: string }) {
  const row = (status?.terminals ?? []).find((r: Record<string, any>) => r?.id === term) ?? null;
  const proper = sessionStateName(row?.sessionState);
  const enabled = row?.enabled !== false;
  const loggedIn = Boolean(row?.isLoggedIn);

  return (
    <SectionShell>
      <SectionCardHead
        icon={Activity}
        title="Broker Health"
        tone="teal"
        right={
          <Button size="sm" variant="ghost" asChild className="h-6 px-2 text-[11px]">
            <Link href="/services/connection-manager">Connections <ArrowUpRight className="ml-1 h-3 w-3" /></Link>
          </Button>
        }
      />
      {!row ? (
        <p className="text-xs text-muted-foreground">No health row for this terminal yet.</p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <LiveDot live={loggedIn && enabled} />
            <StatusBadge status={!enabled ? 'warning' : loggedIn ? 'success' : 'danger'} label={!enabled ? 'Not configured' : loggedIn ? 'Connected' : 'Logged out'} />
          </div>
          <div className="space-y-0.5">
            <InfoRow label="Enabled" value={enabled ? 'yes' : 'no'} />
            <InfoRow label="Logged in" value={loggedIn ? 'yes' : 'no'} />
            <InfoRow label="Session state" value={proper?.label ?? row?.sessionState ?? '—'} />
            <InfoRow label="Last attempt" value={sessionManagerTs(row?.lastAttemptAt ?? row?.updatedAt)} />
            <InfoRow label="Last error" value={row?.lastError ?? 'none'} valueClass={row?.lastError ? 'text-destructive' : 'text-muted-foreground'} />
            <InfoRow label="Attempts" value={row?.attemptCount ?? '—'} />
          </div>
          {proper?.blurb ? (
            <p className="mt-2 border-t border-border/50 pt-2 text-[10px] italic leading-snug text-muted-foreground">
              {proper.blurb}
            </p>
          ) : null}
        </>
      )}
    </SectionShell>
  );
}

// ===========================================================================
// PAGE
// ===========================================================================

export default function TerminalProfilePage({ terminalId }: { terminalId: string }) {
  const router = useRouter();
  const rt = useRealtime();
  const now = useServerNow();
  const term = (terminalId || 'kotak').toLowerCase();
  const combinedMode = term === 'combined';
  const meta1 = TERMINAL_META[term] ?? { name: term, sub: 'Broker terminal', icon: Layers, tone: 'neutral' as AccentTone, kind: 'Broker terminal' };
  const meta = combinedMode
    ? { name: 'Combined', sub: 'Kotak Neo + Shoonya aggregate', icon: Layers, tone: 'purple' as AccentTone, kind: 'Capital aggregate' }
    : meta1;

  const { data, error, loading, refresh } = useBackend(getBrokerTerminalOverview);
  const { data: status, refresh: refreshStatus } = useBackend(getBrokersStatus);
  const session = useBackend(getSessionManagerSession);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const row = combinedMode ? data?.combined : data?.terminals?.[term];
  const activeTerm = data?.active ?? null;
  const isActive = !combinedMode && activeTerm === term;

  const canDash = !combinedMode && !!data && activeTerm === term;
  const dashLoader = useMemo(() => (canDash ? () => getTradingDashboard() : () => null), [canDash]);
  const { data: dash, refresh: refreshDash } = useBackend<TradingDashboardResponse>(dashLoader);

  const handleRefresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await refreshBrokerOverview();
      refresh();
      refreshStatus();
      refreshDash();
      session.refresh();
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : '';
      if (!(/aborted/i.test(msg) || /timed out|timeout/i.test(msg))) {
        console.error('broker profile refresh failed', e);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refresh, refreshStatus, refreshDash, session]);

  const prevConnRef = useRef(rt.appConnection);
  useEffect(() => {
    const prev = prevConnRef.current;
    prevConnRef.current = rt.appConnection;
    if ((prev === 'RECONNECTING' || prev === 'DISCONNECTED' || prev === 'OFFLINE') && rt.appConnection === 'CONNECTED') {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt.appConnection]);

  const live = rt.appConnection === 'CONNECTED';
  const liveLabel = !rt.hydrated
    ? 'Connecting…'
    : live
      ? 'LIVE'
      : rt.appConnection === 'CONNECTING'
        ? 'Connecting'
        : rt.appConnection === 'RECONNECTING'
          ? 'Reconnecting'
          : rt.appConnection === 'OFFLINE'
            ? 'Offline'
            : 'Disconnected';

  const dashSec = dash?.sections;
  const liveFunds = dashSec?.funds?.status === 'ok' ? dashSec.funds.data : null;

  return (
    <div className="space-y-6">
      {/* Compact action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" asChild className="gap-1.5">
            <Link href="/services/broker-terminal"><ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Overview</Link>
          </Button>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {isActive ? 'Active terminal — live ledger attached' : combinedMode ? 'Aggregate ledger' : 'Not active — ledger not attached'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveIndicator live={live} label={liveLabel} />
          <Button size="sm" variant="outline" onClick={handleRefresh} disabled={loading || busy} className="gap-1.5">
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden /> Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => router.push('/services/broker-terminal/terminals')} className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" aria-hidden /> Configure
          </Button>
          {row?.connected ? (
            <Button size="sm" onClick={() => router.push('/trading/trade')} className="gap-1.5">
              <Gauge className="h-3.5 w-3.5" aria-hidden /> Trade
            </Button>
          ) : (
            <Button size="sm" onClick={() => router.push('/services/broker-terminal/terminals')} className="gap-1.5">
              <PlugZap className="h-3.5 w-3.5" aria-hidden /> {row?.enabled === false ? 'Configure' : 'Connect'}
            </Button>
          )}
        </div>
      </div>

      {!data && error ? (
        <ErrorState message={error} onRetry={refresh} />
      ) : (
        <>
          <ProfileHero
            term={term}
            row={row}
            meta={meta}
            activeTerm={activeTerm}
            loading={loading}
            now={now}
            generatedAt={data?.generatedAt}
            funds={combinedMode ? data?.combined : dash?.sections?.funds?.data ?? undefined}
          />

          <section className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-1">
              <IdentitySessionCard term={term} row={row} session={session.data} now={now} combinedMode={combinedMode} />
              <HealthCard status={status} term={term} />
            </div>
            <div className="space-y-4 lg:col-span-2">
              <FundsMarginCard row={row} funds={combinedMode ? data?.combined : liveFunds} dashSection={dashSec?.funds} combinedMode={combinedMode} />

              {combinedMode ? (
                <>
                  <CombinedBrokerBreakdown terminals={data?.terminals ?? {}} combined={data?.combined} />
                  <SectionShell className="border-dashed">
                    <SectionCardHead icon={LineChart} title="Per-broker ledger" tone="neutral" />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Live positions/holdings/orders live in each broker's own profile — the combined card is a capital
                      aggregate only. Open a broker below.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(['kotak', 'shoonya'] as const).map((id) => (
                        <Button key={id} variant="outline" size="sm" asChild>
                          <Link href={`/services/broker-terminal/profile/${id}`}>
                            <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: terminalHue(id) }} />
                            {TERMINAL_META[id].name} profile
                          </Link>
                        </Button>
                      ))}
                    </div>
                  </SectionShell>
                </>
              ) : isActive ? (
                <>
                  {dash && !dash.ok ? <p className="text-xs text-destructive">Terminal dashboard error.</p> : null}
                  <PositionsTable dash={dash} />
                  <HoldingsTable dash={dash} />
                  <OrdersTable dash={dash} />
                </>
              ) : (
                <LedgerUnavailable meta={meta} row={row} activeTerm={activeTerm} />
              )}
            </div>
          </section>

          <section className="space-y-3">
            <SectionHeading>System Status</SectionHeading>
            <SystemStatusStrip />
          </section>
        </>
      )}
    </div>
  );
}