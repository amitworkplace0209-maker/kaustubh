'use client';

import { useEffect, useState, useCallback, useRef, useMemo, memo } from 'react';

import { Card, CardContent } from '@/components/ui/card';

import { Button } from '@/components/ui/button';

import { Badge } from '@/components/ui/badge';

import { Skeleton } from '@/components/ui/skeleton';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import {

  AlertCircle, BarChart3, Briefcase, CheckCircle2,

  ChevronDown, ChevronUp, History, Layers, Power,

  RefreshCw, Sigma, Target, TrendingUp, Zap,

  LayoutGrid, Table2,

} from 'lucide-react';

import {

  getPositions, squareOffPosition, getSystemStatus,

  getQuote, subscribeInstruments, getOrderHistory, type QuoteResponse,

} from '@/lib/api';

import { subscribeSseState, subscribeTicks } from '@/lib/shared-sse';

import {

  calculatePositionCharges, chargesFromPositionValue, demoOrderToTrade,

  kotakRowToTrade, positionKey, emptyBreakdown, extractBrokerCharges,

  type ChargeBreakdown, type ChargesResult, type ExecutedTrade,

} from '@/lib/charge-service';

import {

  CARD_TONE, MetricCard, SectionHeading, pnlTone, stateTone,

} from '@/components/design-system';

import {

  getSettingsStore, useAccountMode, useTradingSettings, type AccountMode,

} from '@/lib/settings-store';

import { TradingService } from '@/lib/trading-service';

import { fmtPct, fmtPnl, fmtQty, fmtRs, pnlClr } from '@/lib/formatters';

import { cn } from '@/lib/utils';

import { useToast } from '@/hooks/use-toast';

import { ChargeDetails } from '@/components/charges/charge-details';

import { useNotificationsPoll } from '@/lib/shared-notifications';

import { useRealtimeChannel } from '@/hooks/use-realtime-channel';

import {

  getTriggerStore, useTriggers, type ArmedTrigger,

} from '@/lib/trigger-store';

import { useTriggerEngine } from '@/hooks/use-trigger-engine';

// ---------------------------------------------------------------------------

// Types

// ---------------------------------------------------------------------------

type Position = {

  id: string;

  symbol: string;

  companyName: string;

  tradingSymbol: string;

  exchange: string;

  product: string;

  instrumentToken: string;

  side: 'LONG' | 'SHORT' | 'FLAT';

  status: 'OPEN' | 'CLOSED' | 'FLAT';

  netQuantity: number;

  buyQuantity: number;

  sellQuantity: number;

  averageBuyPrice: number;

  averageSellPrice: number;

  netAveragePrice: number;

  ltp: number;

  open: number;

  high: number;

  low: number;

  prevClose: number;

  volume: number;

  upperCircuit: number;

  lowerCircuit: number;

  realizedPnl: number;

  unrealizedPnl: number;

  grossPnl: number;

  netPnl: number;

  marketValue: number;

  buyValue: number;

  sellValue: number;

  charges: number;

  chargesKnown: boolean;

  updatedAt: string;

  refId: string;

  dayPnl: number | null;

  positionIndex: number;

  raw: Record<string, unknown>;

};

type Tick = {

  symbol: string;

  tradingSymbol?: string;

  instrumentToken: string;

  exchangeSegment?: string;

  ltp: number;

  change?: number | null;

  changePercent?: number | null;

  ts: string;

  src: 'ws' | 'quote';

};

type Freshness = 'live' | 'demo' | 'stale' | 'offline';

type PosMetrics = {

  ltp: number | null;

  ltpChange: number | null;

  ltpChangePct: number | null;

  tickTsMs: number | null;

  dataSource: string;

  avgPrice: number;

  invested: number | null;

  currentValue: number | null;

  exposure: number | null;

  unrealizedPnl: number;

  realizedPnl: number;

  grossPnl: number;

  netPnl: number;

  pnlPct: number | null;

  /** null = charges not calculable yet ("Pending broker data"). */

  charges: number | null;

  /** True when the value is broker/provider-confirmed (vs configured-rule estimate). */

  chargesConfirmed: boolean;

};

const TICK_STALE_MS = 20_000;

const metricsCacheRef: { current: Map<string, PosMetrics> } = { current: new Map() };

function num(v: unknown): number {

  if (v == null || v === '') return 0;

  const n = Number(v);

  return isNaN(n) ? 0 : n;

}

function str(v: unknown): string {

  if (v == null) return '';

  return String(v);

}

function fmtTime(isoOrMs: string | number | null | undefined): string {

  if (isoOrMs == null || isoOrMs === '') return '\u2014';

  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);

  if (isNaN(d.getTime())) return '\u2014';

  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

}

// ---------------------------------------------------------------------------

// Position normalization

// ---------------------------------------------------------------------------

function normalizePosition(raw: any): Position {

  const r = raw || {};

  const symbol = str(r.sym || r.symbol || r.symbol_name).split('-')[0];

  const tradingSymbol = str(r.trdSym || r.trdSym_clean || r.trading_symbol || r.tradingsymbol || r.tradingSymbol);

  const companyName = str(r.company_name || r.companyName || r.pDesc);

  const exchange = str(r.exSeg || r.exSeg_clean || r.exchange || r.exchange_segment || r.exchangeSegment);

  const product = str(r.prod || r.prod_clean || r.product || r.product_type);

  const instrumentToken = str(r.tok || r.instrument_token || r.instrumentToken || r.token);

  const buyQty = num(r.buy_quantity ?? r.buy_qty ?? r.cfBuyQty ?? r.flBuyQty ?? r.buyQuantity);

  const sellQty = num(r.sell_quantity ?? r.sell_qty ?? r.cfSellQty ?? r.flSellQty ?? r.sellQuantity);

  const sdkNetQty = num(r.qty ?? r.net_qty ?? r.net_quantity ?? r.netQuantity);

  const rawNetQty = sdkNetQty !== 0 ? sdkNetQty : (buyQty - sellQty);

  const absNetQty = Math.abs(rawNetQty);

  const avgBuy = num(r.buy_avg ?? r.buy_average ?? r.avg_price ?? r.average_price ?? r.averageBuyPrice);

  const avgSell = num(r.sell_avg ?? r.sell_average ?? r.averageSellPrice);

  const netAvg = num(r.net_average_price ?? r.avg_price ?? r.average_price ?? r.averagePrice);

  const buyValue = num(r.buy_value) || (buyQty * avgBuy);

  const sellValue = num(r.sell_value) || (sellQty * avgSell);

  const ltpRaw = num(r.ltp ?? r.last_price);

  const lastKnownLtp = r.last_known_ltp != null && num(r.last_known_ltp) > 0 ? num(r.last_known_ltp) : null;

  const ohlc = (r.ohlc || {}) as Record<string, unknown>;

  const open = num(ohlc.open);

  const high = num(ohlc.high);

  const low = num(ohlc.low);

  const prevClose = num(ohlc.close);

  const volume = num(r.volume);

  const upperCircuit = num(r.upper_circuit);

  const lowerCircuit = num(r.lower_circuit);

  let side: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';

  if (rawNetQty > 0) side = 'LONG';

  else if (rawNetQty < 0) side = 'SHORT';

  else {

    const pt = str(r.position_type || r.trnsTp || r.side || r.positionType).toUpperCase();

    if (pt === 'LONG' || pt === 'BUY' || pt === 'B') side = 'LONG';

    else if (pt === 'SHORT' || pt === 'SELL' || pt === 'S') side = 'SHORT';

  }

  const hasActivity = buyQty > 0 || sellQty > 0;

  const canonicalStatus = str(r.position_status).toUpperCase();

  let status: 'OPEN' | 'CLOSED' | 'FLAT';

  if (rawNetQty !== 0) status = 'OPEN';

  else if (canonicalStatus === 'OPEN') status = 'OPEN';

  else if (hasActivity) status = 'CLOSED';

  else status = 'FLAT';

  const brokerRealized = num(r.realised ?? r.realized ?? r.realized_pnl ?? r.realizedPnl);

  const brokerUnrealized = num(r.unrealised ?? r.unrealized ?? r.unrealized_pnl ?? r.unrealizedPnl);

  const refId = str(

    r.rms_pos_id || r.rmsPosId || r.posId || r.position_id ||

    r.ordNo || r.nOrdNo || r.order_id || ''

  );

  const rawDayPnl = r.day_pnl ?? r.dayPnl ?? r.pnl;

  const dayPnl = rawDayPnl != null && rawDayPnl !== '' && Number.isFinite(Number(rawDayPnl))

    ? Number(rawDayPnl)

    : null;

  const effectiveLtp = ltpRaw > 0 ? ltpRaw : (lastKnownLtp != null ? lastKnownLtp : 0);

  const chargesRawVal = r.estimated_charges ?? r.charges ?? r.brokerage ?? r.estimatedCharges;

  const chargesKnown =

    typeof r.charges_known === 'boolean'

      ? r.charges_known

      : chargesRawVal != null && chargesRawVal !== '' && Number.isFinite(Number(chargesRawVal));

  return {

    id: instrumentToken || tradingSymbol || symbol,

    symbol, companyName, tradingSymbol: tradingSymbol || symbol,

    exchange, product, instrumentToken,

    side, status, netQuantity: absNetQty,

    buyQuantity: buyQty, sellQuantity: sellQty,

    averageBuyPrice: avgBuy, averageSellPrice: avgSell, netAveragePrice: netAvg,

    ltp: effectiveLtp,

    open, high, low, prevClose, volume, upperCircuit, lowerCircuit,

    realizedPnl: brokerRealized, unrealizedPnl: brokerUnrealized,

    grossPnl: num(r.gross_pnl ?? r.grossPnl), netPnl: num(r.net_pnl ?? r.netPnl),

    marketValue: num(r.market_value ?? r.marketValue), buyValue, sellValue,

    charges: chargesKnown ? num(chargesRawVal) : 0, chargesKnown,

    updatedAt: str(r.hsUpTm) || new Date().toISOString(),

    refId, dayPnl,

    positionIndex: num(r.position_index ?? r.index),

    raw: r,

  };

}

// ---------------------------------------------------------------------------

// Derived metrics

// ---------------------------------------------------------------------------

function normKey(v: string | null | undefined): string {

  return String(v ?? '').trim().toUpperCase();

}

function findTick(tickMap: Map<string, Tick>, pos: Position): Tick | null {

  if (pos.instrumentToken) { const t = tickMap.get(normKey(pos.instrumentToken)); if (t) return t; }

  if (pos.tradingSymbol) { const t = tickMap.get(normKey(pos.tradingSymbol)); if (t) return t; }

  if (pos.symbol) { const t = tickMap.get(normKey(pos.symbol)); if (t) return t; }

  return null;

}

function parseTsMs(ts: string | undefined): number | null {

  if (!ts) return null;

  const t = new Date(ts).getTime();

  return isNaN(t) ? null : t;

}

function deriveMetrics(pos: Position, tick: Tick | null): PosMetrics {

  const isOpen = pos.status === 'OPEN';

  const isClosed = pos.status === 'CLOSED';

  const qty = pos.netQuantity;

  const hasLiveTick = tick != null && tick.ltp > 0;

  const liveLtp = hasLiveTick ? tick!.ltp : (pos.ltp > 0 ? pos.ltp : null);

  let invested: number | null = null;

  if (pos.buyValue > 0) invested = pos.buyValue;

  else if (pos.sellValue > 0) invested = pos.sellValue;

  else if (pos.netAveragePrice > 0 && qty > 0) invested = pos.netAveragePrice * qty;

  const currentValue = liveLtp != null && qty > 0

    ? qty * liveLtp

    : (pos.marketValue > 0 ? pos.marketValue : null);

  // Exposure is the live market value of the position (qty * LTP).

  const exposure = currentValue;

  let unrealized = pos.unrealizedPnl;

  if (isOpen && liveLtp != null && qty > 0 && pos.netAveragePrice > 0) {

    unrealized = pos.side === 'LONG'

      ? (liveLtp - pos.netAveragePrice) * qty

      : (pos.netAveragePrice - liveLtp) * qty;

  }

  const realized = pos.realizedPnl;

  const gross = realized + unrealized;

  const charges = pos.chargesKnown ? pos.charges : null;

  // Charges are an expense — internally signed as negative so net = gross + signedCharges.

  const signedCharges = charges != null ? -Math.abs(charges) : null;

  const net = signedCharges != null ? gross + signedCharges : gross;

  let pnlPct: number | null = null;

  if (invested != null && invested > 0) pnlPct = (gross / invested) * 100;

  else if (isClosed && pos.buyValue > 0) pnlPct = (realized / pos.buyValue) * 100;

  const dataSource = isClosed

    ? 'Broker history'

    : hasLiveTick

      ? (tick!.src === 'quote' ? 'Quote API' : 'Live tick stream')

      : 'Broker snapshot';

  return {

    ltp: liveLtp,

    ltpChange: hasLiveTick && tick!.change != null ? tick!.change : null,

    ltpChangePct: hasLiveTick && tick!.changePercent != null ? tick!.changePercent : null,

    tickTsMs: hasLiveTick ? parseTsMs(tick!.ts) : null,

    dataSource,

    avgPrice: pos.netAveragePrice,

    invested,

    currentValue,

    exposure,

    unrealizedPnl: unrealized,

    realizedPnl: realized,

    grossPnl: gross,

    netPnl: net,

    pnlPct,

    charges,

    chargesConfirmed: pos.chargesKnown,

  };

}

function sameMetrics(a: PosMetrics, b: PosMetrics): boolean {

  return a.ltp === b.ltp

    && a.ltpChange === b.ltpChange

    && a.ltpChangePct === b.ltpChangePct

    && a.tickTsMs === b.tickTsMs

    && a.dataSource === b.dataSource

    && a.invested === b.invested

    && a.currentValue === b.currentValue

    && a.exposure === b.exposure

    && a.unrealizedPnl === b.unrealizedPnl

    && a.realizedPnl === b.realizedPnl

    && a.grossPnl === b.grossPnl

    && a.netPnl === b.netPnl

    && a.pnlPct === b.pnlPct

    && a.charges === b.charges

    && a.chargesConfirmed === b.chargesConfirmed;

}

// ---------------------------------------------------------------------------

// Shared UI atoms

// ---------------------------------------------------------------------------

const DASH = '\u2014';

function DM({ label, value }: { label: string; value: React.ReactNode }) {

  return (

    <div className="pos-detail-item">

      <div className="pos-detail-label">{label}</div>

      <div className="pos-detail-value">{value}</div>

    </div>

  );

}

function ModeChip({ mode }: { mode: AccountMode }) {

  const api = mode === 'api';

  return (

    <span

      title={api ? 'Real broker account (Kotak Neo)' : 'Virtual demo account (paper trading)'}

      className={cn(

        'inline-flex flex-col justify-center rounded-md border px-2 py-[3px] leading-tight transition-colors duration-200',

        api

          ? 'border-success/30 bg-success/[0.07] shadow-[0_0_14px_-6px_hsl(var(--success)/0.45)]'

          : 'border-purple/40 bg-purple/[0.07] shadow-[0_0_14px_-6px_hsl(var(--purple)/0.45)]'

      )}

    >

      <span className={cn('flex items-center gap-1.5 text-[11px] font-semibold tracking-wide', api ? 'text-success' : 'text-purple')}>

        <span

          aria-hidden

          className={cn(

            'h-1.5 w-1.5 rounded-full animate-pulse',

            api

              ? 'bg-success [box-shadow:0_0_5px_hsl(var(--success)/0.7)]'

              : 'bg-purple [box-shadow:0_0_5px_hsl(var(--purple)/0.6)]'

          )}

        />

        {api ? 'API MODE' : 'DEMO MODE'}

      </span>

      <span className="text-[9px] font-normal text-muted-foreground">

        {api ? 'Live broker data' : 'Demo trading data'}

      </span>

    </span>

  );

}

const FRESH_META: Record<Freshness, { chip: string; dot: string; text: string; label: string }> = {

  live: {

    chip: 'border-success/25 bg-success/[0.07]',

    dot: 'bg-success animate-pulse [box-shadow:0_0_5px_hsl(var(--success)/0.7)]',

    text: 'text-success',

    label: 'LIVE',

  },

  demo: {

    chip: 'border-purple/40 bg-purple/[0.07]',

    dot: 'bg-purple animate-pulse [box-shadow:0_0_5px_hsl(var(--purple)/0.6)]',

    text: 'text-purple',

    label: 'DEMO',

  },

  stale: {

    chip: 'border-warning/40 bg-warning/[0.08]',

    dot: 'bg-warning animate-pulse',

    text: 'text-warning',

    label: 'STALE',

  },

  offline: {

    chip: 'border-destructive/30 bg-destructive/[0.07]',

    dot: 'bg-destructive',

    text: 'text-destructive',

    label: 'OFFLINE',

  },

};

function FreshnessChip({ fresh, updatedLabel }: { fresh: Freshness; updatedLabel: string }) {

  const m = FRESH_META[fresh];

  return (

    <span title={`${m.label} \u00B7 ${updatedLabel}`} className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[2px] text-[10px] font-medium tabular-nums', m.chip)}>

      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', m.dot)} />

      <span className={cn('font-semibold tracking-wide', m.text)}>{m.label}</span>

      <span aria-hidden className="opacity-40">{'\u2022'}</span>

      <span className="hidden text-muted-foreground md:inline">{updatedLabel}</span>

    </span>

  );

}

function useTickFlash(ltp: number | null): 'up' | 'down' | null {

  const prevRef = useRef<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dir, setDir] = useState<'up' | 'down' | null>(null);

  useEffect(() => {

    const prev = prevRef.current;

    prevRef.current = ltp;

    if (ltp == null || prev == null || ltp === prev) return;

    setDir(ltp > prev ? 'up' : 'down');

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => setDir(null), 600);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };

  }, [ltp]);

  return dir;

}

// ---------------------------------------------------------------------------

// Position card — professional trading-terminal design

// ---------------------------------------------------------------------------

const PositionCard = memo(function PositionCard({

  pos, m, fresh, isExpanded, onToggle, onSquareOff, targetPct, slPct,

  breakdown, chargesConfirmed, armedTriggers,

}: {

  pos: Position; m: PosMetrics; fresh: Freshness; isExpanded: boolean;

  onToggle: () => void; onSquareOff: () => void;

  targetPct: number; slPct: number;

  breakdown: ChargeBreakdown | null;

  chargesConfirmed?: boolean;

  armedTriggers?: ArmedTrigger[];

}) {

  const isOpen = pos.status === 'OPEN';

  const isClosed = pos.status === 'CLOSED';

  const hasLtp = m.ltp != null && m.ltp > 0;

  // Prefer engine-calculated charges (from order history) over backend-reported.

  const effectiveCharges = breakdown != null && breakdown.totalCharges > 0

    ? breakdown.totalCharges

    : (m.charges ?? 0);

  const flash = useTickFlash(m.ltp);

  const changeClr = m.ltpChange != null && m.ltpChange !== 0 ? pnlClr(m.ltpChange) : 'text-muted-foreground';

  const cardPnl = m.netPnl;

  const tone = CARD_TONE[pnlTone(cardPnl)];

  const updatedIso = m.tickTsMs != null ? m.tickTsMs : pos.updatedAt;

  const updatedLabel = `Updated ${fmtTime(updatedIso)}`;

  // Charges display: real negative when known, ₹0.00 only when the broker /

  // engine genuinely priced them as zero, otherwise pending → "—".

  const chargesKnownFlag = m.chargesConfirmed || chargesConfirmed === true || (breakdown != null && breakdown.totalCharges > 0);

  const chargesNode = effectiveCharges > 0

    ? <span className="text-destructive">{fmtPnl(-Math.abs(effectiveCharges))}</span>

    : chargesKnownFlag

      ? <span className="text-muted-foreground">{fmtRs(0)}</span>

      : <span className="text-muted-foreground">{DASH}</span>;

  const targetPrice = targetPct !== 0 && pos.netAveragePrice > 0

    ? pos.side === 'LONG' ? pos.netAveragePrice * (1 + targetPct / 100) : pos.netAveragePrice * (1 - targetPct / 100)

    : null;

  const slPrice = slPct !== 0 && pos.netAveragePrice > 0

    ? pos.side === 'LONG' ? pos.netAveragePrice * (1 - Math.abs(slPct) / 100) : pos.netAveragePrice * (1 + Math.abs(slPct) / 100)

    : null;

  const targetPnl = targetPrice != null && isOpen && m.avgPrice > 0

    ? (pos.side === 'LONG' ? (targetPrice - m.avgPrice) : (m.avgPrice - targetPrice)) * pos.netQuantity

    : null;

  const slPnlVal = slPrice != null && isOpen && m.avgPrice > 0

    ? (pos.side === 'LONG' ? (slPrice - m.avgPrice) : (m.avgPrice - slPrice)) * pos.netQuantity

    : null;

  // Card-level net P&L uses engine charges when available for accurate display.

  const cardNetPnl = m.grossPnl - effectiveCharges;

  const displayPnl = isClosed ? cardNetPnl : cardNetPnl;

  const displayPnlPct = m.invested != null && m.invested > 0

    ? (m.grossPnl / m.invested) * 100

    : m.pnlPct;

  return (

    <Card

      data-status={cardPnl > 0 ? 'profit' : cardPnl < 0 ? 'loss' : 'neutral'}

      className={cn(

        'pos-card group relative overflow-hidden transition-[box-shadow,border-color] duration-200',

        tone.border, tone.restShadow, tone.hoverBorder, tone.hoverShadow,

        isClosed && 'opacity-75',

      )}

    >

      {/* Top accent bar */}

      {!isClosed && <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2px]', tone.bar)} />}

      <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent', tone.tint)} />

      {/* ── HEADER ROW ── */}

      <div

        className="relative cursor-pointer select-none transition-colors hover:bg-muted/30 px-4 pt-3 pb-2"

        onClick={onToggle}

        role="button"

        tabIndex={0}

        aria-expanded={isExpanded}

        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}

      >

        <div className="flex items-start justify-between gap-3">

          {/* Left: symbol, company, badges */}

          <div className="min-w-0 flex-1">

            <div className="flex flex-wrap items-center gap-1.5">

              <span className="text-muted-foreground">

                {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}

              </span>

              <span className="text-sm font-bold tracking-tight sm:text-[15px]">

                {pos.tradingSymbol || pos.symbol || DASH}

              </span>

              <Badge

                variant="outline"

                className={cn(

                  'px-1.5 py-0 text-[9px] font-semibold',

                  pos.side === 'LONG'

                    ? 'border-success/40 bg-success/10 text-success'

                    : pos.side === 'SHORT'

                      ? 'border-destructive/40 bg-destructive/10 text-destructive'

                      : ''

                )}

              >

                {pos.side}

              </Badge>

              {isOpen && (

                <Badge className="border-success/40 bg-success/10 px-1.5 py-0 text-[9px] font-bold text-success">

                  OPEN

                </Badge>

              )}

              {isClosed && (

                <Badge variant="secondary" className="px-1.5 py-0 text-[9px] font-semibold">

                  CLOSED

                </Badge>

              )}

              {isOpen && armedTriggers && armedTriggers.length > 0 && (

                <>

                  {armedTriggers.map((t) => (

                    <span

                      key={t.id}

                      className={cn(

                        'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[9px] font-semibold tabular-nums',

                        t.kind === 'TARGET'

                          ? 'border-teal/30 bg-teal/[0.08] text-teal'

                          : 'border-destructive/30 bg-destructive/[0.08] text-destructive',

                      )}

                    >

                      {t.kind === 'TARGET' ? 'T' : 'SL'} {fmtRs(t.triggerPrice).replace('\u20B9', '')}

                    </span>

                  ))}

                </>

              )}

            </div>

            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 ml-5 text-[11px] text-muted-foreground">

              {pos.companyName && <span className="truncate max-w-[200px]">{pos.companyName}</span>}

              <span>{[pos.exchange, pos.product].filter(Boolean).join(' \u00B7 ')}</span>

            </div>

          </div>

          {/* Right: BIG P&L panel */}

          <div className="flex-shrink-0 text-right">

            <div className={cn(

              'text-lg font-bold leading-tight tabular-nums sm:text-xl',

              pnlClr(displayPnl),

            )}>

              {fmtPnl(displayPnl)}

            </div>

            {displayPnlPct != null && (

              <div className={cn('text-xs font-semibold tabular-nums', pnlClr(displayPnl))}>

                {fmtPct(displayPnlPct)}

              </div>

            )}

            {isOpen && effectiveCharges > 0 && (

              <div className="text-[10px] text-destructive tabular-nums">

                Charges {fmtPnl(-Math.abs(effectiveCharges))}

              </div>

            )}

          </div>

        </div>

      </div>

      {/* ── METRIC STRIP ── */}

      <div className="pos-card-metrics relative">

        {isClosed ? (

          <>

            <div className="pos-metric pos-metric-accent-avg">

              <div className="pos-metric-label">Entry Price</div>

              <div className="pos-metric-value">{m.avgPrice > 0 ? fmtRs(m.avgPrice) : DASH}</div>

            </div>

            <div className="pos-metric pos-metric-accent-ltp">

              <div className="pos-metric-label">Exit Price</div>

              <div className="pos-metric-value">{pos.averageSellPrice > 0 ? fmtRs(pos.averageSellPrice) : DASH}</div>

            </div>

            <div className="pos-metric pos-metric-accent-qty">

              <div className="pos-metric-label">QTY</div>

              <div className="pos-metric-value">{fmtQty(pos.netQuantity)}</div>

            </div>

            <div className="pos-metric">

              <div className="pos-metric-label">Invested</div>

              <div className="pos-metric-value">{m.invested != null ? fmtRs(m.invested) : DASH}</div>

            </div>

            <div className="pos-metric pos-metric-accent-charges">

              <div className="pos-metric-label">Charges</div>

              <div className="pos-metric-value">

                {chargesNode}

              </div>

            </div>

            <div className="pos-metric pos-metric-accent-target">

              <div className="pos-metric-label">Gross P&L</div>

              <div className={cn('pos-metric-value', pnlClr(m.grossPnl))}>{fmtPnl(m.grossPnl)}</div>

            </div>

            <div className="pos-metric pos-metric-accent-sl">

              <div className="pos-metric-label">Net P&L</div>

              <div className={cn('pos-metric-value', pnlClr(m.netPnl))}>{fmtPnl(m.netPnl)}</div>

            </div>

          </>

        ) : (

          <>

            <div className={cn('pos-metric pos-metric-accent-ltp ltp-flash', flash === 'up' && 'ltp-flash-up', flash === 'down' && 'ltp-flash-down')}>

              <div className="pos-metric-label">LTP</div>

              <div className="pos-metric-value">{hasLtp ? fmtRs(m.ltp!) : DASH}</div>

              {(m.ltpChange != null || m.ltpChangePct != null) && (

                <div className={cn('text-[10px] font-medium leading-tight tabular-nums', changeClr)}>

                  {m.ltpChange != null ? fmtPnl(m.ltpChange) : DASH}

                  {m.ltpChangePct != null ? ` (${fmtPct(m.ltpChangePct)})` : ''}

                </div>

              )}

            </div>

            <div className="pos-metric pos-metric-accent-avg">

              <div className="pos-metric-label">Avg Price</div>

              <div className="pos-metric-value">{m.avgPrice > 0 ? fmtRs(m.avgPrice) : DASH}</div>

            </div>

            <div className="pos-metric pos-metric-accent-qty">

              <div className="pos-metric-label">QTY</div>

              <div className="pos-metric-value">{fmtQty(pos.netQuantity)}</div>

            </div>

            <div className="pos-metric">

              <div className="pos-metric-label">Invested</div>

              <div className="pos-metric-value">{m.invested != null ? fmtRs(m.invested) : DASH}</div>

            </div>

            <div className="pos-metric pos-metric-accent-value">

              <div className="pos-metric-label">Current Value</div>

              <div className="pos-metric-value">{m.currentValue != null ? fmtRs(m.currentValue) : DASH}</div>

            </div>

            <div className="pos-metric">

              <div className="pos-metric-label">Exposure</div>

              <div className="pos-metric-value">{m.exposure != null ? fmtRs(m.exposure) : DASH}</div>

            </div>

            <div className="pos-metric pos-metric-accent-charges">

              <div className="pos-metric-label">Charges</div>

              <div className="pos-metric-value">

                {chargesNode}

              </div>

            </div>

          </>

        )}

      </div>

      {/* ── FOOTER ── */}

      <div className="relative flex items-center justify-between gap-2 px-4 pb-2.5">

        <button

          className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"

          onClick={(e) => { e.stopPropagation(); onToggle(); }}

        >

          {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}

          {isExpanded ? 'Hide Details' : 'View Details'}

        </button>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">

          <span className="hidden items-center gap-2 text-[11px] tabular-nums text-muted-foreground sm:flex">

            <span>BUY <span className="font-semibold text-foreground">{fmtQty(pos.buyQuantity)}</span></span>

            <span>SELL <span className="font-semibold text-foreground">{fmtQty(pos.sellQuantity)}</span></span>

          </span>

          {isClosed ? (

            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border/70 bg-muted/40 px-2 py-[2px] text-[10px] font-medium tabular-nums text-muted-foreground">

              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />

              HISTORY

              <span aria-hidden className="opacity-40">{'\u2022'}</span>

              <span className="hidden md:inline">{updatedLabel}</span>

            </span>

          ) : (

            <FreshnessChip fresh={fresh} updatedLabel={updatedLabel} />

          )}

          {isOpen && (

            <Button

              size="sm"

              variant="destructive"

              className="h-7 px-3 text-xs font-semibold"

              onClick={(e) => { e.stopPropagation(); onSquareOff(); }}

            >

              <Power className="mr-1 h-3 w-3" /> Square Off

            </Button>

          )}

        </div>

      </div>

      {/* ── EXPANDED DETAILS ── */}

      {isExpanded && (

        <div className="pos-expanded-panel relative space-y-3 border-t border-border bg-muted/20 px-4 py-3">

          <div className="pos-section">

            <div className="pos-section-title"><BarChart3 className="h-3 w-3" /> Market Data</div>

            <div className="detail-metric-grid">

              <DM label="LTP" value={hasLtp ? fmtRs(m.ltp!) : DASH} />

              <DM label="CHANGE" value={m.ltpChange != null ? <span className={changeClr}>{fmtPnl(m.ltpChange)}</span> : DASH} />

              <DM label="CHANGE %" value={m.ltpChangePct != null ? <span className={changeClr}>{fmtPct(m.ltpChangePct)}</span> : DASH} />

              <DM label="OPEN" value={pos.open > 0 ? fmtRs(pos.open) : DASH} />

              <DM label="HIGH" value={pos.high > 0 ? fmtRs(pos.high) : DASH} />

              <DM label="LOW" value={pos.low > 0 ? fmtRs(pos.low) : DASH} />

              <DM label="PREV CLOSE" value={pos.prevClose > 0 ? fmtRs(pos.prevClose) : DASH} />

              <DM label="VOLUME" value={pos.volume > 0 ? fmtQty(pos.volume) : DASH} />

              <DM label="UPPER CIRCUIT" value={pos.upperCircuit > 0 ? fmtRs(pos.upperCircuit) : DASH} />

              <DM label="LOWER CIRCUIT" value={pos.lowerCircuit > 0 ? fmtRs(pos.lowerCircuit) : DASH} />

            </div>

          </div>

          <div className="pos-section">

            <div className="pos-section-title"><Zap className="h-3 w-3" /> Execution</div>

            <div className="detail-metric-grid">

              <DM label="NET QTY" value={<span className="font-semibold">{fmtQty(pos.netQuantity)}</span>} />

              <DM label="BUY QTY" value={fmtQty(pos.buyQuantity)} />

              <DM label="SELL QTY" value={fmtQty(pos.sellQuantity)} />

              <DM label="AVG BUY PRICE" value={pos.averageBuyPrice > 0 ? fmtRs(pos.averageBuyPrice) : DASH} />

              <DM label="AVG SELL PRICE" value={pos.averageSellPrice > 0 ? fmtRs(pos.averageSellPrice) : DASH} />

              <DM label="AVG PRICE" value={m.avgPrice > 0 ? fmtRs(m.avgPrice) : DASH} />

              <DM label="INVESTED VALUE" value={m.invested != null ? fmtRs(m.invested) : DASH} />

              <DM label="CURRENT VALUE" value={m.currentValue != null ? fmtRs(m.currentValue) : DASH} />

              <DM label="BUY VALUE" value={pos.buyValue > 0 ? fmtRs(pos.buyValue) : DASH} />

              <DM label="SELL VALUE" value={pos.sellValue > 0 ? fmtRs(pos.sellValue) : DASH} />

            </div>

          </div>

          <div className="pos-section">

            <div className="pos-section-title"><TrendingUp className="h-3 w-3" /> P&amp;L Details</div>

            <div className="detail-metric-grid">

              <DM label="UNREALIZED P&L" value={<span className={pnlClr(m.unrealizedPnl)}>{fmtPnl(m.unrealizedPnl)}</span>} />

              <DM label="REALIZED P&L" value={<span className={pnlClr(m.realizedPnl)}>{fmtPnl(m.realizedPnl)}</span>} />

              <DM label="GROSS P&L" value={<span className={pnlClr(m.grossPnl)}>{fmtPnl(m.grossPnl)}</span>} />

              {pos.dayPnl != null && <DM label="DAY P&L" value={<span className={pnlClr(pos.dayPnl)}>{fmtPnl(pos.dayPnl)}</span>} />}

              <DM label={isOpen ? 'ESTIMATED CHARGES' : 'CHARGES'} value={chargesNode} />

              <DM label="NET P&L" value={<span className={cn('font-semibold', pnlClr(m.netPnl))}>{fmtPnl(m.netPnl)}</span>} />

              <DM label="P&L %" value={<span className={pnlClr(m.netPnl)}>{m.pnlPct != null ? fmtPct(m.pnlPct) : DASH}</span>} />

            </div>

          </div>

          <div className="pos-section">

            <div className="pos-section-title"><Briefcase className="h-3 w-3" /> Position Info</div>

            <div className="detail-metric-grid">

              <DM label="SYMBOL" value={pos.tradingSymbol || DASH} />

              {pos.companyName && <DM label="COMPANY" value={<span className="truncate">{pos.companyName}</span>} />}

              <DM label="EXCHANGE" value={pos.exchange || DASH} />

              <DM label="PRODUCT" value={pos.product || DASH} />

              <DM label="POSITION TYPE" value={pos.side} />

              <DM label="STATUS" value={pos.status} />

              <DM label="TOKEN" value={pos.instrumentToken || DASH} />

              {pos.refId && <DM label="POSITION REF" value={pos.refId} />}

              <DM label="LAST UPDATED" value={fmtTime(updatedIso)} />

              <DM label="DATA SOURCE" value={m.dataSource} />

            </div>

          </div>

          {(targetPrice != null || slPrice != null) && isOpen && (

            <div className="pos-section">

              <div className="pos-section-title"><Target className="h-3 w-3" /> Risk Management</div>

              <div className="detail-metric-grid">

                <DM label="TARGET PRICE" value={targetPrice != null ? fmtRs(targetPrice) : 'Not Set'} />

                <DM label="TARGET %" value={targetPct !== 0 ? fmtPct(targetPct) : DASH} />

                {targetPnl != null && <DM label="TARGET P&L" value={<span className="text-success">{fmtPnl(targetPnl)}</span>} />}

                <DM label="STOP LOSS" value={slPrice != null ? fmtRs(slPrice) : 'Not Set'} />

                <DM label="SL %" value={slPct !== 0 ? `${fmtPct(slPct).replace('+', '')}` : DASH} />

                {slPnlVal != null && <DM label="POTENTIAL LOSS" value={<span className="text-destructive">{fmtPnl(slPnlVal)}</span>} />}

                {armedTriggers && armedTriggers.length > 0 && (

                  armedTriggers.map((t) => (

                    <DM

                      key={t.id}

                      label={`ARMED ${t.kind === 'TARGET' ? 'TARGET' : 'STOP LOSS'}`}

                      value={<span className="font-semibold text-info">{fmtRs(t.triggerPrice)}</span>}

                    />

                  ))

                )}

              </div>

            </div>

          )}

          <ChargeDetails

            values={breakdown ? {

              brokerage: breakdown.brokerage,

              stt: breakdown.stt,

              exchangeTransactionCharges: breakdown.exchangeCharges,

              sebiCharges: breakdown.sebiCharges,

              stampDuty: breakdown.stampDuty,

              gst: breakdown.gst,

              otherCharges: breakdown.otherCharges,

              totalCharges: breakdown.totalCharges,

            } : null}

            turnover={(pos.buyValue > 0 ? pos.buyValue : 0) + (pos.sellValue > 0 ? pos.sellValue : 0) || null}

            confirmed={chargesConfirmed}

            className="bg-card"

          />

          <details className="text-[10px] text-muted-foreground">

            <summary className="cursor-pointer select-none hover:text-foreground">Raw API Response</summary>

            <pre className="mt-1.5 max-h-36 overflow-auto rounded bg-muted p-2 font-mono text-[10px]">

              {JSON.stringify(pos.raw, null, 2)}

            </pre>

          </details>

        </div>

      )}

    </Card>

  );

});

const PositionTableRow = memo(function PositionTableRow({

  pos, m, breakdown, confirmed, onSquareOff, onToggle, isExpanded,

}: {

  pos: Position; m: PosMetrics; breakdown: ChargeBreakdown | null; confirmed?: boolean;

  onSquareOff: () => void; onToggle: () => void; isExpanded: boolean;

}) {

  const flash = useTickFlash(m.ltp);

  const effectiveCharges = breakdown != null && breakdown.totalCharges > 0 ? breakdown.totalCharges : (m.charges ?? 0);

  const chargesKnown = m.chargesConfirmed || confirmed === true || (breakdown != null && breakdown.totalCharges > 0);

  const chargesNode = effectiveCharges > 0

    ? <span className="text-destructive">{fmtPnl(-Math.abs(effectiveCharges))}</span>

    : chargesKnown ? <span className="text-muted-foreground">{fmtRs(0)}</span> : <span className="text-muted-foreground">—</span>;

  const netRowPnl = m.grossPnl - effectiveCharges;

  const pnlPct = m.invested != null && m.invested > 0 ? (m.grossPnl / m.invested) * 100 : m.pnlPct;

  return (

    <>

      <TableRow className="group hover:bg-muted/40">

        <TableCell className="font-medium whitespace-nowrap">

          <div className="flex flex-col">

            <span className="text-sm font-bold">{pos.tradingSymbol || pos.symbol || '—'}</span>

            {pos.companyName && <span className="max-w-[140px] truncate text-[10px] text-muted-foreground">{pos.companyName}</span>}

            <span className="text-[10px] text-muted-foreground">{pos.exchange} · {pos.product}</span>

          </div>

        </TableCell>

        <TableCell>

          <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px] font-semibold', pos.side === 'LONG' ? 'border-success/40 bg-success/10 text-success' : pos.side === 'SHORT' ? 'border-destructive/40 bg-destructive/10 text-destructive' : '')}>

            {pos.side}

          </Badge>

        </TableCell>

        <TableCell className="text-right tabular-nums">{fmtQty(pos.netQuantity)}</TableCell>

        <TableCell className="text-right tabular-nums">{m.avgPrice > 0 ? fmtRs(m.avgPrice) : '—'}</TableCell>

        <TableCell className={cn('text-right tabular-nums font-mono', flash === 'up' && 'bg-success/10 text-success', flash === 'down' && 'bg-destructive/10 text-destructive', 'rounded')}>

          {m.ltp != null && m.ltp > 0 ? fmtRs(m.ltp) : '—'}

          {m.ltpChange != null && <div className={cn('text-[10px]', pnlClr(m.ltpChange))}>{fmtPnl(m.ltpChange)}</div>}

        </TableCell>

        <TableCell className="text-right tabular-nums">{m.currentValue != null ? fmtRs(m.currentValue) : '—'}</TableCell>

        <TableCell className={cn('text-right tabular-nums font-medium', pnlClr(m.grossPnl))}>{fmtPnl(m.grossPnl)}</TableCell>

        <TableCell className={cn('text-right tabular-nums text-xs', pnlClr(pnlPct))}>{pnlPct != null ? fmtPct(pnlPct) : '—'}</TableCell>

        <TableCell className="text-right tabular-nums">{chargesNode}</TableCell>

        <TableCell className={cn('text-right tabular-nums font-semibold', pnlClr(netRowPnl))}>{fmtPnl(netRowPnl)}</TableCell>

        <TableCell className="text-right">

          <div className="flex items-center justify-end gap-1">

            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={onToggle}>

              {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}

            </Button>

            <Button size="sm" variant="destructive" className="h-7 px-2 text-[11px]" onClick={onSquareOff}>

              <Power className="h-3 w-3" />

            </Button>

          </div>

        </TableCell>

      </TableRow>

      {isExpanded && (

        <TableRow>

          <TableCell colSpan={11} className="bg-muted/20 p-0">

            <div className="space-y-3 px-4 py-3">

              <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">

                <DM label="Invested" value={m.invested != null ? fmtRs(m.invested) : '—'} />

                <DM label="Exposure" value={m.exposure != null ? fmtRs(m.exposure) : '—'} />

                <DM label="Realized P&L" value={<span className={pnlClr(m.realizedPnl)}>{fmtPnl(m.realizedPnl)}</span>} />

                <DM label="Unrealized P&L" value={<span className={pnlClr(m.unrealizedPnl)}>{fmtPnl(m.unrealizedPnl)}</span>} />

                <DM label="Buy Qty" value={fmtQty(pos.buyQuantity)} />

                <DM label="Sell Qty" value={fmtQty(pos.sellQuantity)} />

                <DM label="Market Value" value={pos.marketValue > 0 ? fmtRs(pos.marketValue) : '—'} />

                <DM label="Status" value={pos.status} />

              </div>

              <ChargeDetails

                values={breakdown ? {

                  brokerage: breakdown.brokerage,

                  stt: breakdown.stt,

                  exchangeTransactionCharges: breakdown.exchangeCharges,

                  sebiCharges: breakdown.sebiCharges,

                  stampDuty: breakdown.stampDuty,

                  gst: breakdown.gst,

                  otherCharges: breakdown.otherCharges,

                  totalCharges: breakdown.totalCharges,

                } : null}

                turnover={(pos.buyValue > 0 ? pos.buyValue : 0) + (pos.sellValue > 0 ? pos.sellValue : 0) || null}

                confirmed={confirmed}

                className="bg-card"

              />

            </div>

          </TableCell>

        </TableRow>

      )}

    </>

  );

});

function PositionSkeleton() {

  return (

    <Card className="shadow-soft">

      <div className="space-y-2 px-4 py-3">

        <div className="flex items-center justify-between">

          <Skeleton className="h-4 w-40" />

          <Skeleton className="h-4 w-20" />

        </div>

        <div className="flex flex-wrap gap-1">

          {Array.from({ length: 6 }).map((_, j) => (

            <div key={j} className="min-w-0 grow-0 basis-[calc(33.333%-3px)] rounded border border-border/40 bg-muted/50 px-2 py-1 sm:basis-[calc(16.666%-4px)]">

              <Skeleton className="mb-1 h-2 w-10" />

              <Skeleton className="h-3 w-14" />

            </div>

          ))}

        </div>

        <div className="flex items-center justify-between">

          <Skeleton className="h-3 w-20" />

          <Skeleton className="h-5 w-32" />

        </div>

      </div>

    </Card>

  );

}

function PositionAlertsPanel() {

  const { notifications } = useNotificationsPoll({ pollMs: 15000 });

  const positionAlerts = useMemo(() => {

    const filtered = (notifications || []).filter((n) => {

      const cat = String(n.category || '').toLowerCase();

      const title = String(n.title || '').toLowerCase();

      const msg = String(n.message || '').toLowerCase();

      return cat.includes('position') || cat.includes('trading') || cat.includes('order') || title.includes('position') || title.includes('square') || msg.includes('position') || msg.includes('target') || msg.includes('stop');

    });

    return filtered.slice(0, 5);

  }, [notifications]);

  if (positionAlerts.length === 0) {

    return (

      <Card className="shadow-soft">

        <CardContent className="py-6 text-center">

          <p className="text-xs text-muted-foreground">No recent position alerts — alerts for target hit, stop loss, square-off and margin will appear here.</p>

        </CardContent>

      </Card>

    );

  }

  return (

    <Card className="shadow-soft">

      <CardContent className="divide-y divide-border/40 p-0">

        {positionAlerts.map((a) => (

          <div key={a._id} className="flex items-start justify-between gap-3 px-4 py-3">

            <div className="min-w-0">

              <p className="truncate text-xs font-medium">{a.title || a.category || 'Position alert'}</p>

              {a.message && <p className="truncate text-[11px] text-muted-foreground">{a.message}</p>}

            </div>

            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{a.ts ? fmtTime(a.ts) : ''}</span>

          </div>

        ))}

      </CardContent>

    </Card>

  );

}

// ---------------------------------------------------------------------------

// Page

// ---------------------------------------------------------------------------

export default function PositionsPage() {

  const mode = useAccountMode();

  const settings = useTradingSettings();

  const targetPct = settings.target.enabled ? settings.target.value : 0;

  const slPct = settings.stopLoss.enabled ? settings.stopLoss.value : 0;

  const pollMs = Math.max(2000, num(settings.advanced.positionRefreshInterval) || 5000);

  const [positions, setPositions] = useState<Position[]>([]);

  const [system, setSystem] = useState<any>(null);

  const [everLoaded, setEverLoaded] = useState(false);

  const [feedError, setFeedError] = useState<string | null>(null);

  const [fetching, setFetching] = useState(false);

  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);

  const [squareOffTarget, setSquareOffTarget] = useState<Position | null>(null);

  const [squareOffSending, setSquareOffSending] = useState(false);

  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const [expandTotalPnl, setExpandTotalPnl] = useState(false);

  const [expandPositions, setExpandPositions] = useState(false);

  const [viewMode, setViewMode] = useState<'TABLE' | 'CARDS'>('TABLE');

  // Open upar, Closed neeche — dono alag sections. Toggle se ek time pe
  // sirf ek section bhi dekha ja sakta hai (dono ek saath nahi).
  const [showOpen, setShowOpen] = useState(true);
  const [showClosed, setShowClosed] = useState(true);

  const [chargeByPos, setChargeByPos] = useState<Map<string, ChargesResult>>(new Map());

  const chargesBusyRef = useRef(false);

  // IST calendar date (YYYY-MM-DD) for day-scoping charges + flip detection.
  const istDayOf = (ms: number) =>
    new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const refreshChargeBreakdowns = useCallback(async () => {

    if (chargesBusyRef.current) return;

    chargesBusyRef.current = true;

    try {

      const res = await getOrderHistory();

      const rows: any[] = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);

      // Day-scoped charges: yesterday's executions must not price today's
      // positions. Trades without a parseable timestamp are kept (legacy).
      const today = istDayOf(Date.now());

      const tradesByKey = new Map<string, ExecutedTrade[]>();

      for (const raw of rows) {

        const t = kotakRowToTrade(raw);

        if (!t) continue;

        if (t.ts) {
          const d = new Date(t.ts);
          if (!isNaN(d.getTime()) && istDayOf(d.getTime()) !== today) continue;
        }

        const key = positionKey(t.symbol, t.product);

        const list = tradesByKey.get(key);

        if (list) list.push(t); else tradesByKey.set(key, [t]);

      }

      const next = new Map<string, ChargesResult>();

      for (const [key, trades] of tradesByKey) {

        next.set(key, calculatePositionCharges(trades));

      }

      if (mountedRef.current) setChargeByPos(next);

    } catch (err) {

      console.warn('[positions] charge breakdown fetch failed:', err);

    } finally {

      chargesBusyRef.current = false;

    }

  }, []);

  const [tickMap, setTickMap] = useState<Map<string, Tick>>(new Map());

  const [wsConnected, setWsConnected] = useState(false);

  const [lastTickAt, setLastTickAt] = useState<number | null>(null);

  const [nowTick, setNowTick] = useState(() => Date.now());

  const mountedRef = useRef(true);

  const prevModeRef = useRef<AccountMode>(mode);

  const pendingTicksRef = useRef<Tick[]>([]);

  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const subscribedTokensRef = useRef<Set<string>>(new Set());

  const { toast } = useToast();

  useEffect(() => {

    mountedRef.current = true;

    return () => { mountedRef.current = false; };

  }, []);

  const applyPositions = useCallback((rawPositions: any[]) => {

    const normalized = rawPositions.map((p: any) => {

      try { return normalizePosition(p); }

      catch (e) { console.warn('[positions] normalize error:', e, p); return null; }

    }).filter(Boolean) as Position[];

    if (!mountedRef.current) return;

    setPositions(normalized);

    setLastSuccessAt(Date.now());

    setFeedError(null);

    setEverLoaded(true);

  }, []);

  const fetchMissingQuotes = useCallback(async (missing: Position[]) => {

    try {

      const tokens = missing.map((p) => ({ instrument_token: p.instrumentToken }));

      const res: QuoteResponse = await getQuote(tokens, 'ltp');

      const arr = Array.isArray(res?.data) ? res.data : (res?.data ? [res.data] : []);

      if (arr.length === 0 || !mountedRef.current) return;

      const incoming: Tick[] = [];

      for (const item of arr) {

        const ltpVal = num(item.ltp || item.last_price);

        if (ltpVal <= 0) continue;

        incoming.push({

          symbol: str(item.symbol || item.sym_clean || ''),

          tradingSymbol: str(item.trdSym || item.trading_symbol || ''),

          instrumentToken: str(item.exchange_token || item.instrument_token || ''),

          ltp: ltpVal,

          ts: new Date().toISOString(),

          src: 'quote',

        });

      }

      if (incoming.length === 0) return;

      setTickMap((prev) => {

        const next = new Map(prev);

        for (const t of incoming) {

          if (t.instrumentToken) next.set(normKey(t.instrumentToken), t);

          if (t.symbol) next.set(normKey(t.symbol), t);

          if (t.tradingSymbol) next.set(normKey(t.tradingSymbol), t);

        }

        return next;

      });

    } catch (err) { console.warn('[positions] quote fetch failed:', err); }

  }, []);

  const ensureLiveQuotes = useCallback((open: Position[]) => {

    const candidates = open.filter((p) => p.instrumentToken);

    const fresh = candidates.filter((p) => {

      const key = `${p.exchange || 'nse_cm'}:${p.instrumentToken}`;

      if (subscribedTokensRef.current.has(key)) return false;

      subscribedTokensRef.current.add(key);

      return true;

    });

    if (fresh.length === 0) return;

    subscribeInstruments(fresh.map((p) => ({

      instrument_token: p.instrumentToken,

      exchange_segment: p.exchange || 'nse_cm',

      isIndex: false,

      isDepth: false,

      symbol: p.symbol,

    }))).catch((err) => {

      console.warn('[positions] live quote subscribe failed:', err);

      for (const p of fresh) {

        subscribedTokensRef.current.delete(`${p.exchange || 'nse_cm'}:${p.instrumentToken}`);

      }

    });

  }, []);

  // -------------------------------------------------------------------------
  // Realtime channels — the socket carries the data; REST is the fallback
  // -------------------------------------------------------------------------

  const positionsChannel = useRealtimeChannel<Record<string, any>>('positions', {
    fallback: async () => {
      const store = getSettingsStore();
      const currentMode = store.getMode();
      const res = currentMode === 'demo'
        ? await TradingService.getPositions()
        : await getPositions();
      const data = res?.data ?? (Array.isArray(res) ? res : []);
      return { positions: Array.isArray(data) ? data : [] };
    },
    fallbackKey: 'positions',
    fallbackMs: pollMs,
  });

  const systemChannel = useRealtimeChannel('system', {
    fallback: async () => ({ status: await getSystemStatus() }),
    fallbackKey: 'system:status',
    fallbackMs: pollMs,
  });

  const positionsDoc = positionsChannel.data;

  const docRows = Array.isArray(positionsDoc?.positions) ? (positionsDoc!.positions as any[]) : null;

  const docTerminal = typeof positionsDoc?.terminal === 'string' ? positionsDoc!.terminal : null;

  // The socket always describes the ACTIVE terminal. While a terminal switch
  // is in flight the document may still belong to the previous terminal — the
  // REST path wins for that one frame.
  const acceptedTerminals = mode === 'demo' ? ['dummy'] : ['kotak', 'shoonya'];

  const docMatchesMode = !docTerminal || acceptedTerminals.includes(docTerminal);

  // The document IS the data — apply it whenever it changes.
  useEffect(() => {

    if (!docRows || !docMatchesMode) return;

    applyPositions(docRows);

    refreshChargeBreakdowns();

    const open = docRows

      .map((p: any) => { try { return normalizePosition(p); } catch { return null; } })

      .filter((p: Position | null): p is Position => Boolean(p));

    ensureLiveQuotes(open.filter((p) => p.status === 'OPEN'));

    const missing = open.filter((p) => p.status === 'OPEN' && p.ltp === 0 && p.instrumentToken);

    if (missing.length > 0) fetchMissingQuotes(missing);

  }, [docRows, docMatchesMode, applyPositions, refreshChargeBreakdowns, ensureLiveQuotes, fetchMissingQuotes]);

  // The system status rides the same socket (`system` channel).
  const wsSystemStatus = (systemChannel.data?.status ?? null) as any;

  useEffect(() => {

    if (!mountedRef.current) return;

    setSystem(mode === 'demo' ? { demoMode: true } : wsSystemStatus);

  }, [mode, wsSystemStatus]);

  const fetchPositions = useCallback(async () => {

    if (mountedRef.current) setFetching(true);

    try {

      // Ask the backend to re-push the authoritative document. When the socket
      // is down the hook's REST fallback takes over on its own.
      positionsChannel.refresh();

    } finally {

      if (mountedRef.current) setFetching(false);

    }

  }, [positionsChannel]);

  useEffect(() => {

    if (prevModeRef.current !== mode) {

      prevModeRef.current = mode;

      setPositions([]);

      setSystem(null);

      setFeedError(null);

      setEverLoaded(false);

      setTickMap(new Map());

      subscribedTokensRef.current.clear();

      // The terminal changed — ask the backend for the new terminal's document.
      positionsChannel.refresh();

    }

  }, [mode, positionsChannel]);

  const dayFlipRef = useRef<string>(istDayOf(Date.now()));

  useEffect(() => {

    const interval = setInterval(() => {
      const nowMs = Date.now();
      setNowTick(nowMs);
      // Day flip: yesterday's page must not survive into the new date —
      // drop rows immediately and refetch (backend is day-scoped too).
      const day = istDayOf(nowMs);
      if (day !== dayFlipRef.current) {
        dayFlipRef.current = day;
        if (mountedRef.current) {
          setPositions([]);
          setChargeByPos(new Map());
          setTickMap(new Map());
          subscribedTokensRef.current.clear();
        }
        fetchPositions();
      }
    }, 5000);

    return () => clearInterval(interval);

  }, [fetchPositions]);

  // Shared SSE tick stream — one browser-wide session via `subscribeTicks`

  useEffect(() => {

    const commitTicks = () => {

      flushTimerRef.current = null;

      const batch = pendingTicksRef.current;

      pendingTicksRef.current = [];

      if (batch.length === 0 || !mountedRef.current) return;

      setLastTickAt(Date.now());

      setTickMap((prev) => {

        const next = new Map(prev);

        for (const t of batch) {

          if (t.instrumentToken) next.set(normKey(t.instrumentToken), t);

          if (t.symbol) next.set(normKey(t.symbol), t);

          if (t.tradingSymbol) next.set(normKey(t.tradingSymbol), t);

        }

        return next;

      });

    };

    const queueTick = (tick: Tick) => {

      pendingTicksRef.current.push(tick);

      if (flushTimerRef.current == null) {

        flushTimerRef.current = setTimeout(commitTicks, 150);

      }

    };

    // Shared module owns the EventSource + reconnect; this page only feeds it.

    const offState = subscribeSseState((s) => setWsConnected(Boolean(s.connected)));

    const offTicks = subscribeTicks((raw) => {

      try {

        if (raw?.ltp == null || raw?.ltp === 0) return;

        const tick: Tick = {
          symbol: str(raw.symbol || ''),
          tradingSymbol: str(raw.tradingSymbol || ''),
          instrumentToken: str(raw.instrumentToken || ''),
          ltp: num(raw.ltp),
          change: raw.change ?? null,
          changePercent: raw.changePercent ?? null,
          ts: str(raw.ts || '') || new Date().toISOString(),
          src: 'ws',
        };

        if (mountedRef.current) queueTick(tick);

      } catch { /* ignore malformed frame */ }

    });

    return () => {

      offState();

      offTicks();

      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

      pendingTicksRef.current = [];

    };

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, []);

  // ---- derived: per-position metrics ----

  const metricsById = useMemo(() => {

    const prevMap = metricsCacheRef.current;

    const next = new Map<string, PosMetrics>();

    for (const p of positions) {

      const m = deriveMetrics(p, findTick(tickMap, p));

      const prev = prevMap.get(p.id);

      next.set(p.id, prev && sameMetrics(prev, m) ? prev : m);

    }

    metricsCacheRef.current = next;

    return next;

  }, [positions, tickMap]);

  // STABLE SORTING: open positions by positionIndex (API order),

  // closed positions by positionIndex descending (newest first).

  // This ensures cards NEVER jump when LTP/P&L changes.

  const openPositions = useMemo(() => {

    return positions

      .filter((p) => p.status === 'OPEN')

      .sort((a, b) => a.positionIndex - b.positionIndex);

  }, [positions]);

  const closedPositions = useMemo(() => {

    return positions

      .filter((p) => p.status === 'CLOSED')

      .sort((a, b) => b.positionIndex - a.positionIndex);

  }, [positions]);

  // ---- trigger evaluation ----

  const { evaluateTriggers } = useTriggerEngine();

  useEffect(() => {

    if (tickMap.size === 0) return;

    let cancelled = false;

    evaluateTriggers((t) => {

      const probe = {

        symbol: t.symbol, tradingSymbol: t.tradingSymbol, instrumentToken: t.token,

      } as unknown as Position;

      const tick = findTick(tickMap, probe);

      return tick?.ltp ?? null;

    })

      .then((outcomes) => {

        if (cancelled) return;

        for (const o of outcomes) {

          toast(o.ok

            ? {

                title: o.kind === 'TARGET' ? 'Target reached \u2014 squared off' : 'Stop loss hit \u2014 squared off',

                description: o.detail,

              }

            : {

                title: 'Auto square-off failed',

                description: o.detail,

                variant: 'destructive' as const,

              });

        }

      })

      .catch(() => { /* failures recorded on the trigger itself */ });

    return () => { cancelled = true; };

  }, [tickMap, evaluateTriggers, toast]);

  const allTriggers = useTriggers();

  const armedByPositionId = useMemo(() => {

    const map = new Map<string, ArmedTrigger[]>();

    for (const t of allTriggers) {

      if (t.status !== 'ARMED') continue;

      const list = map.get(t.positionId);

      if (list) list.push(t); else map.set(t.positionId, [t]);

    }

    return map;

  }, [allTriggers]);

  useEffect(() => {

    if (allTriggers.length === 0) return;

    const openIds = new Set(openPositions.map((p) => positionKey(p.symbol, p.product)));

    const now = Date.now();

    for (const t of getTriggerStore().getArmed()) {

      const ageMs = now - new Date(t.createdAt).getTime();

      if (!openIds.has(t.positionId) && ageMs > 60_000) {

        getTriggerStore().cancel(t.id);

      }

    }

  }, [openPositions, allTriggers]);

  // ---- derived: summary totals ----

  const totals = useMemo(() => {

    let realized = 0, unrealized = 0, invested = 0, exposure = 0;

    let closedRealized = 0;

    let longCount = 0, shortCount = 0, longQty = 0, shortQty = 0;

    let sawInvested = false;

    let chargesSum = 0;

    let sawCharges = false;

    let anyConfirmed = false;

    let anyCalculated = false;

    for (const p of openPositions) {

      const m = metricsById.get(p.id);

      if (!m) continue;

      unrealized += m.unrealizedPnl;

      realized += m.realizedPnl;

      if (m.invested != null) { invested += m.invested; sawInvested = true; }

      // Exposure = live market value of open positions (qty * LTP), like Dashboard.

      const ltpForExposure = m.ltp ?? 0;

      if (ltpForExposure > 0 && p.netQuantity > 0) {

        exposure += ltpForExposure * p.netQuantity;

      } else if (m.invested != null) {

        exposure += m.invested;

      }

      if (p.side === 'LONG') { longCount++; longQty += p.netQuantity; }

      else if (p.side === 'SHORT') { shortCount++; shortQty += p.netQuantity; }

      // Charges: prefer order-engine breakdown (more accurate) over backend field.

      const pkey = positionKey(p.symbol, p.product);

      const cr = chargeByPos.get(pkey);

      if (cr && cr.known) {

        chargesSum += cr.breakdown.totalCharges;

        sawCharges = true;

        if (cr.confirmed) anyConfirmed = true; else anyCalculated = true;

      } else if (p.chargesKnown && p.charges > 0) {

        chargesSum += p.charges;

        sawCharges = true;

      }

    }

    for (const p of closedPositions) {

      realized += p.realizedPnl;

      closedRealized += p.realizedPnl;

      const pkey = positionKey(p.symbol, p.product);

      const cr = chargeByPos.get(pkey);

      if (cr && cr.known) {

        chargesSum += cr.breakdown.totalCharges;

        sawCharges = true;

        if (cr.confirmed) anyConfirmed = true; else anyCalculated = true;

      } else if (p.chargesKnown && p.charges > 0) {

        chargesSum += p.charges;

        sawCharges = true;

      }

    }

    const gross = realized + unrealized;

    // Net = gross + signed charges (charges internally negative).

    const net = gross - chargesSum;

    const totalPct = sawInvested && invested > 0 ? (net / invested) * 100 : null;

    return {

      realized, unrealized, gross, net, totalPct, invested, exposure,

      closedRealized,

      charges: chargesSum,

      chargesKnown: sawCharges || anyConfirmed || anyCalculated,

      chargesSource: anyConfirmed ? 'broker-confirmed' : anyCalculated ? 'calculated' : sawCharges ? 'broker-reported' : null,

      longCount, shortCount, longQty, shortQty,

    };

  }, [openPositions, closedPositions, metricsById, chargeByPos]);

  // ---- freshness ----

  const sysWsOk = system?.websocketConnected ?? false;

  const loggedIn = system?.pythonStatus?.logged_in ?? system?.logged_in ?? system?.demoMode ?? false;

  const feedFreshness: Freshness = (() => {

    if (mode === 'demo') return 'demo';

    if (!loggedIn) return 'offline';

    if (feedError != null) return everLoaded ? 'stale' : 'offline';

    const recentTick = lastTickAt != null && nowTick - lastTickAt <= TICK_STALE_MS;

    if ((wsConnected || sysWsOk) && recentTick) return 'live';

    return 'stale';

  })();

  const cardFreshness = useCallback((m: PosMetrics | undefined): Freshness => {

    if (mode === 'demo') return 'demo';

    if (feedError != null) return 'offline';

    if (m?.tickTsMs != null && nowTick - m.tickTsMs <= TICK_STALE_MS) return 'live';

    if (wsConnected || sysWsOk) return 'stale';

    return 'offline';

  }, [mode, feedError, wsConnected, sysWsOk, nowTick]);

  const down = feedError != null && !everLoaded;

  const degraded = feedError != null && everLoaded;

  const loadingCards = !everLoaded && !down;

  const headerUpdated = (() => {

    if (feedFreshness === 'live' && lastTickAt != null) return fmtTime(lastTickAt);

    if (lastSuccessAt != null) return fmtTime(lastSuccessAt);

    return '\u2014';

  })();

  const handleSquareOff = async (pos: Position) => {

    if (pos.side === 'FLAT') return;

    setSquareOffSending(true);

    const qty = String(pos.netQuantity);

    const posType = pos.side === 'LONG' ? 'SELL' : 'BUY';

    try {

      await squareOffPosition({ exchange: pos.exchange || 'nse_cm', token: pos.instrumentToken, product: pos.product, quantity: qty, position_type: posType });

      getTriggerStore().cancelByPosition(positionKey(pos.symbol, pos.product));

      toast({ title: 'Position squared off', description: `${pos.tradingSymbol} ${posType} x ${qty}` });

      setSquareOffTarget(null);

      await fetchPositions();

    } catch (err) {

      toast({ title: 'Square off failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });

    } finally { setSquareOffSending(false); }

  };

  const toggleExpand = (id: string) => {

    setExpandedRows((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  };

  return (

    <div className="positions-page space-y-6 px-4 py-4 sm:px-6 lg:px-8">

      {/* Header */}

      <div className="flex flex-wrap items-end justify-between gap-3">

        <div>

          <div className="flex flex-wrap items-center gap-2">

            <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>

            <ModeChip mode={mode} />

            <FreshnessChip

              fresh={feedFreshness}

              updatedLabel={headerUpdated === '—' ? 'Connecting…' : `Updated ${headerUpdated}`}

            />

            <span
              title="Day-scoped page — the broker book is intraday and prior dates auto-settle at 08:50 IST"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-[2px] text-[10px] font-semibold tabular-nums text-sky-500"
            >
              Today · {istDayOf(nowTick)} IST · resets 08:50
            </span>

          </div>

          <p className="mt-1 text-sm font-normal text-muted-foreground">Live open and closed positions with real-time P&amp;L</p>

        </div>

        <Button size="sm" variant="ghost" onClick={fetchPositions} aria-label="Refresh positions" disabled={fetching}>

          <RefreshCw className={cn('h-4 w-4', fetching ? 'animate-spin' : '')} />

        </Button>

      </div>

      {degraded && (

        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-4 py-2.5">

          <AlertCircle className="h-4 w-4 shrink-0 text-warning" />

          <p className="text-sm font-normal text-warning">

            Position data unavailable &mdash; showing last known values.

            {lastSuccessAt != null && <> Last successful update: <span className="font-semibold tabular-nums">{fmtTime(lastSuccessAt)}</span>.</>}

          </p>

          <Button size="sm" variant="outline" className="ml-auto h-7 shrink-0" onClick={fetchPositions}>

            Retry

          </Button>

        </div>

      )}

      {/* Summary — exactly 4 primary cards per spec: Open Positions | Current Value | Unrealized P&L | Net P&L */}

      <section aria-label="Positions summary" className="space-y-2">

        <div className="flex items-center justify-between">

          <SectionHeading>Summary</SectionHeading>

          <span className="text-[11px] tabular-nums text-muted-foreground">Last updated {headerUpdated === '\u2014' ? '—' : `${headerUpdated} IST`}</span>

        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">

          {/* 1 — OPEN POSITIONS */}

          <MetricCard

            icon={Briefcase}

            tone="neutral"

            dataVerify="open-positions"

            title="Open Positions"

            value={down ? null : String(openPositions.length)}

            unavailable={down}

            sub={down ? undefined : `${totals.longCount}L / ${totals.shortCount}S · Qty ${fmtQty(totals.longQty + totals.shortQty)}`}

            loading={loadingCards}

            stale={degraded}

          />

          {/* 2 — CLOSED POSITIONS (total closed + realized) */}

          <MetricCard

            icon={History}

            tone="neutral"

            dataVerify="closed-positions"

            title="Closed Positions"

            value={down ? null : String(closedPositions.length)}

            unavailable={down}

            sub={down ? undefined : `Realized ${fmtPnl(totals.closedRealized)}`}

            loading={loadingCards}

            stale={degraded}

          />

          {/* 3 — CURRENT VALUE / EXPOSURE */}

          <MetricCard

            icon={Layers}

            tone={down ? 'neutral' : stateTone(totals.exposure, 'teal')}

            dataVerify="current-value"

            title="Current Value"

            value={down ? null : fmtRs(Math.abs(totals.exposure))}

            unavailable={down}

            sub="Live market value · Qty × LTP"

            loading={loadingCards}

            stale={degraded || (!down && feedFreshness === 'stale')}

          />

          {/* 4 — UNREALIZED P&L */}

          <MetricCard

            icon={TrendingUp}

            tone={down ? 'neutral' : pnlTone(totals.unrealized)}

            dataVerify="unrealized-pnl"

            title="Unrealized P&L"

            value={down ? null : fmtPnl(totals.unrealized)}

            unavailable={down}

            sub={down ? undefined : `${totals.unrealized >= 0 ? '+' : ''}${totals.totalPct != null ? fmtPct(totals.totalPct) : '—'} of invested`}

            valueClass={pnlClr(totals.unrealized)}

            loading={loadingCards}

            stale={degraded}

          />

          {/* 5 — NET P&L (gross - charges) */}

          <Card

            data-verify="net-pnl"

            className={cn(

              'group relative cursor-pointer overflow-hidden transition-all duration-200 hover:-translate-y-0.5',

              CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].border,

              CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].restShadow,

              CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].hoverBorder,

              CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].hoverShadow,

            )}

            onClick={() => setExpandTotalPnl((v) => !v)}

          >

            <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2px]', CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].bar)} />

            <span aria-hidden className={cn('pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent', CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].tint)} />

            <CardContent className="relative px-4 py-3">

              <div className="flex items-center gap-2">

                <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-colors duration-200', CARD_TONE[down ? 'neutral' : pnlTone(totals.net)].icon)}>

                  <Sigma className="h-4 w-4" />

                </span>

                <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">Net P&amp;L</p>

                <span className="text-[10px] text-muted-foreground">{expandTotalPnl ? '\u25B2' : '\u25BC'}</span>

              </div>

              <div className="mt-1 min-h-[32px]">

                {down ? (

                  <p className="truncate text-sm font-medium leading-8 text-muted-foreground">Data unavailable</p>

                ) : (

                  <p className={cn('truncate text-xl font-semibold leading-8 tracking-tight tabular-nums', pnlClr(totals.net))}>

                    {fmtPnl(totals.net)}

                  </p>

                )}

              </div>

              <p className="truncate text-[11px] font-normal leading-4 text-muted-foreground tabular-nums">

                {down ? 'Feed error \u00B7 retrying' : `Gross ${fmtPnl(totals.gross)} · Charges ${totals.chargesKnown ? fmtPnl(-Math.abs(totals.charges)) : '—'}`}

              </p>

              {expandTotalPnl && !down && (

                <div className="pos-summary-expand mt-3 space-y-1.5 border-t border-border/50 pt-2.5">

                  <div className="flex items-center justify-between text-[11px]">

                    <span className="text-muted-foreground">Gross P&amp;L</span>

                    <span className={cn('font-semibold tabular-nums', pnlClr(totals.gross))}>{fmtPnl(totals.gross)}</span>

                  </div>

                  <div className="flex items-center justify-between text-[11px]">

                    <span className="text-muted-foreground">Realized P&amp;L</span>

                    <span className={cn('font-semibold tabular-nums', pnlClr(totals.realized))}>{fmtPnl(totals.realized)}</span>

                  </div>

                  <div className="flex items-center justify-between text-[11px]">

                    <span className="text-muted-foreground">Unrealized P&amp;L</span>

                    <span className={cn('font-semibold tabular-nums', pnlClr(totals.unrealized))}>{fmtPnl(totals.unrealized)}</span>

                  </div>

                  <div className="flex items-center justify-between text-[11px]">

                    <span className="text-muted-foreground">Charges</span>

                    <span className={cn('font-semibold tabular-nums', totals.charges > 0 ? 'text-destructive' : '')}>

                      {totals.chargesKnown ? fmtPnl(-Math.abs(totals.charges)) : '\u2014'}

                    </span>

                  </div>

                  <div className="my-1 border-t border-border/40" />

                  <div className="flex items-center justify-between text-xs font-semibold">

                    <span>Net P&amp;L</span>

                    <span className={cn('tabular-nums', pnlClr(totals.net))}>{fmtPnl(totals.net)}</span>

                  </div>

                </div>

              )}

            </CardContent>

          </Card>

          {/* 6 — DAY P&L (open live unrealized + closed realized) */}

          <MetricCard

            icon={Zap}

            tone={down ? 'neutral' : pnlTone(totals.unrealized + totals.closedRealized)}

            dataVerify="day-pnl"

            title="Day P&L"

            value={down ? null : fmtPnl(totals.unrealized + totals.closedRealized)}

            unavailable={down}

            sub={down ? undefined : `Open ${fmtPnl(totals.unrealized)} · Closed ${fmtPnl(totals.closedRealized)}`}

            valueClass={pnlClr(totals.unrealized + totals.closedRealized)}

            loading={loadingCards}

            stale={degraded}

          />

        </div>

        {/* Secondary line: Realized P&L · Total Charges · Last updated */}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[11px] tabular-nums">

          <span className="text-muted-foreground">Realized P&amp;L <span className={cn('font-semibold', pnlClr(totals.realized))}>{down ? '—' : fmtPnl(totals.realized)}</span></span>

          <span className="hidden text-muted-foreground/40 sm:inline">·</span>

          <span className="text-muted-foreground">Total Charges <span className={cn('font-semibold', totals.charges > 0 ? 'text-destructive' : 'text-muted-foreground')}>{totals.chargesKnown ? fmtRs(totals.charges) : '—'}</span></span>

          <span className="hidden text-muted-foreground/40 sm:inline">·</span>

          <span className="text-muted-foreground">Last updated <span className="font-semibold text-foreground">{headerUpdated === '\u2014' ? '—' : `${headerUpdated} IST`}</span></span>

          {totals.chargesSource && <span className="ml-auto text-[10px] text-muted-foreground">Charges: {totals.chargesSource}</span>}

        </div>

      </section>

      {/* Positions blotter — OPEN upar apne live card me, CLOSED neeche apne history card me. */}

      <section aria-label="Position blotter" className="space-y-5">

        {!everLoaded ? (

          down ? (

            <Card className="shadow-soft">

              <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">

                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/15 text-destructive ring-1 ring-inset ring-destructive/30">

                  <AlertCircle className="h-5 w-5" />

                </span>

                <p className="text-sm font-medium">Unable to load positions</p>

                <p className="max-w-md text-xs text-muted-foreground">{feedError || 'Unknown error occurred'}</p>

                <Button size="sm" variant="outline" className="mt-1" onClick={fetchPositions}>

                  <RefreshCw className="mr-1 h-3 w-3" /> Retry

                </Button>

              </CardContent>

            </Card>

          ) : (

            Array.from({ length: 3 }).map((_, i) => <PositionSkeleton key={i} />)

          )

        ) : positions.length === 0 ? (

          <Card className="shadow-soft">

            <CardContent className="flex flex-col items-center justify-center gap-1.5 py-8 text-center">

              <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-inset ring-border/50">

                <Briefcase className="h-5 w-5" />

              </span>

              <p className="text-sm font-medium">No open positions</p>

              <p className="text-xs text-muted-foreground">Trade to create a position.</p>

              <Button size="sm" variant="outline" className="mt-2" onClick={fetchPositions}>

                <RefreshCw className="mr-1 h-3 w-3" /> Refresh

              </Button>

            </CardContent>

          </Card>

        ) : (

          <>

            {/* ═══ OPEN — upar, apna alag live card ═══ */}

            <div className="space-y-3 rounded-xl border border-success/25 bg-card p-3 shadow-sm sm:p-4">

            <div className="flex flex-wrap items-center justify-between gap-2">

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowOpen((v) => !v)}
                  className="inline-flex items-center rounded-md border border-border px-1.5 py-1 text-muted-foreground hover:text-foreground"
                  aria-label={showOpen ? 'Collapse open positions' : 'Expand open positions'}
                >
                  {showOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                <SectionHeading>Open Positions{openPositions.length > 0 ? ` (${openPositions.length})` : ''}</SectionHeading>
                {openPositions.length > 0 && (
                  <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold tabular-nums text-success">
                    OPEN · LIVE
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 rounded-lg border border-border/50 bg-muted/20 p-1">

                <button

                  type="button"

                  onClick={() => setViewMode('TABLE')}

                  className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors', viewMode === 'TABLE' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}

                >

                  <Table2 className="h-3.5 w-3.5" /> Table

                </button>

                <button

                  type="button"

                  onClick={() => setViewMode('CARDS')}

                  className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors', viewMode === 'CARDS' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}

                >

                  <LayoutGrid className="h-3.5 w-3.5" /> Cards

                </button>

              </div>

            </div>

            {!showOpen ? (

              <p className="px-1 py-1 text-xs text-muted-foreground">Collapsed — header toggle se wapas kholo.</p>

            ) : openPositions.length === 0 ? (

              <p className="rounded-lg border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground">

                No open positions — you currently have no active positions.

              </p>

            ) : viewMode === 'TABLE' ? (

              <Card className="overflow-hidden shadow-soft">

                <div className="overflow-x-auto">

                  <Table>

                    <TableHeader className="sticky top-0 bg-muted/50 backdrop-blur">

                      <TableRow>

                        <TableHead>Symbol</TableHead>

                        <TableHead>Side</TableHead>

                        <TableHead className="text-right">Qty</TableHead>

                        <TableHead className="text-right">Avg Price</TableHead>

                        <TableHead className="text-right">LTP</TableHead>

                        <TableHead className="text-right">Current Value</TableHead>

                        <TableHead className="text-right">P&amp;L</TableHead>

                        <TableHead className="text-right">P&amp;L %</TableHead>

                        <TableHead className="text-right">Charges</TableHead>

                        <TableHead className="text-right">Net P&amp;L</TableHead>

                        <TableHead className="text-right">Action</TableHead>

                      </TableRow>

                    </TableHeader>

                    <TableBody>

                      {openPositions.map((pos) => (

                        <PositionTableRow

                          key={pos.id}

                          pos={pos}

                          m={metricsById.get(pos.id)!}

                          breakdown={chargeByPos.get(positionKey(pos.symbol, pos.product))?.breakdown ?? null}

                          confirmed={chargeByPos.get(positionKey(pos.symbol, pos.product))?.confirmed}

                          isExpanded={expandedRows.has(pos.id)}

                          onToggle={() => toggleExpand(pos.id)}

                          onSquareOff={() => setSquareOffTarget(pos)}

                        />

                      ))}

                    </TableBody>

                  </Table>

                </div>

              </Card>

            ) : (

              <div className="space-y-4">

              {openPositions.map((pos) => (

                <PositionCard

                  key={pos.id} pos={pos} m={metricsById.get(pos.id)!}

                  fresh={cardFreshness(metricsById.get(pos.id))}

                  isExpanded={expandedRows.has(pos.id)}

                  onToggle={() => toggleExpand(pos.id)}

                  onSquareOff={() => setSquareOffTarget(pos)}

                  targetPct={targetPct} slPct={slPct}

                  breakdown={chargeByPos.get(positionKey(pos.symbol, pos.product))?.breakdown ?? null}

                  chargesConfirmed={chargeByPos.get(positionKey(pos.symbol, pos.product))?.confirmed}

                  armedTriggers={armedByPositionId.get(positionKey(pos.symbol, pos.product))}

                />

              ))}

              </div>

            )}

            </div>

            {/* ═══ CLOSED — neeche, apna alag history card ═══ */}

            {closedPositions.length > 0 && (

              <div className="space-y-3 rounded-xl border border-border/70 bg-muted/[0.15] p-3 sm:p-4">

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowClosed((v) => !v)}
                      className="inline-flex items-center rounded-md border border-border px-1.5 py-1 text-muted-foreground hover:text-foreground"
                      aria-label={showClosed ? 'Collapse closed positions' : 'Expand closed positions'}
                    >
                      {showClosed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    </button>
                    <SectionHeading>Closed Positions ({closedPositions.length})</SectionHeading>
                    <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] font-bold tabular-nums text-muted-foreground">
                      CLOSED · HISTORY
                    </span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ring-1 ring-inset', totals.closedRealized >= 0 ? 'bg-success/10 text-success ring-success/25' : 'bg-destructive/10 text-destructive ring-destructive/25')}>
                      {fmtPnl(totals.closedRealized)} realized
                    </span>
                  </div>
                </div>

                {showClosed ? (
                <>

                {viewMode === 'TABLE' ? (

                  <Card className="overflow-hidden shadow-soft opacity-95">

                    <div className="overflow-x-auto">

                      <Table>

                        <TableHeader>

                          <TableRow>

                            <TableHead>Symbol</TableHead>

                            <TableHead>Side</TableHead>

                            <TableHead className="text-right">Qty</TableHead>

                            <TableHead className="text-right">Entry</TableHead>

                            <TableHead className="text-right">Exit</TableHead>

                            <TableHead className="text-right">Gross P&amp;L</TableHead>

                            <TableHead className="text-right">Charges</TableHead>

                            <TableHead className="text-right">Net P&amp;L</TableHead>

                            <TableHead>Closed</TableHead>

                          </TableRow>

                        </TableHeader>

                        <TableBody>

                          {closedPositions.map((pos) => {

                            const m = metricsById.get(pos.id)!;

                            const breakdown = chargeByPos.get(positionKey(pos.symbol, pos.product))?.breakdown ?? null;

                            const effCharges = breakdown != null && breakdown.totalCharges > 0 ? breakdown.totalCharges : (m.charges ?? 0);

                            const net = m.grossPnl - effCharges;

                            return (

                              <TableRow key={pos.id} className="opacity-80">

                                <TableCell className="font-medium">{pos.tradingSymbol || pos.symbol}</TableCell>

                                <TableCell><Badge variant="outline" className="text-[10px]">{pos.side}</Badge></TableCell>

                                <TableCell className="text-right tabular-nums">{fmtQty(pos.netQuantity)}</TableCell>

                                <TableCell className="text-right tabular-nums">{m.avgPrice > 0 ? fmtRs(m.avgPrice) : '—'}</TableCell>

                                <TableCell className="text-right tabular-nums">{pos.averageSellPrice > 0 ? fmtRs(pos.averageSellPrice) : fmtRs(m.ltp ?? 0)}</TableCell>

                                <TableCell className={cn('text-right tabular-nums', pnlClr(m.grossPnl))}>{fmtPnl(m.grossPnl)}</TableCell>

                                <TableCell className="text-right tabular-nums">{effCharges > 0 ? fmtPnl(-effCharges) : '—'}</TableCell>

                                <TableCell className={cn('text-right tabular-nums font-medium', pnlClr(net))}>{fmtPnl(net)}</TableCell>

                                <TableCell className="text-xs tabular-nums">{fmtTime(pos.updatedAt)}</TableCell>

                              </TableRow>

                            );

                          })}

                        </TableBody>

                      </Table>

                    </div>

                  </Card>

                ) : (

                  closedPositions.map((pos) => (

                    <PositionCard

                      key={pos.id} pos={pos} m={metricsById.get(pos.id)!}

                      fresh={cardFreshness(metricsById.get(pos.id))}

                      isExpanded={expandedRows.has(pos.id)}

                      onToggle={() => toggleExpand(pos.id)}

                      onSquareOff={() => setSquareOffTarget(pos)}

                      targetPct={0} slPct={0}

                      breakdown={chargeByPos.get(positionKey(pos.symbol, pos.product))?.breakdown ?? null}

                      chargesConfirmed={chargeByPos.get(positionKey(pos.symbol, pos.product))?.confirmed}

                    />

                  ))

                )}

                {closedPositions.length === 0 && <p className="rounded-lg border border-border/40 bg-card px-4 py-3 text-xs text-muted-foreground">No closed positions today</p>}

                </>
                ) : (
                  <p className="px-1 py-1 text-xs text-muted-foreground">Collapsed — header toggle se wapas kholo.</p>
                )}

              </div>

            )}

            {closedPositions.length === 0 && viewMode === 'TABLE' && openPositions.length > 0 && (

              <p className="rounded-lg border border-border/40 bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">No closed positions today — closed trades appear here after square-off.</p>

            )}

          </>

        )}

      </section>

      {/* Recent Position Alerts — uses existing notification system, no second subsystem */}

      <section aria-label="Recent position alerts" className="space-y-3">

        <SectionHeading>Recent Position Alerts</SectionHeading>

        <PositionAlertsPanel />

      </section>

      {/* Square off confirmation */}

      <Dialog open={!!squareOffTarget} onOpenChange={(open) => { if (!open) { setSquareOffTarget(null); setSquareOffSending(false); } }}>

        <DialogContent>

          <DialogHeader><DialogTitle>Square Off Position</DialogTitle></DialogHeader>

          {squareOffTarget && (() => {

            const m = metricsById.get(squareOffTarget.id);

            const effLtp = m?.ltp ?? null;

            const estVal = effLtp != null ? squareOffTarget.netQuantity * effLtp : null;

            const pkey = positionKey(squareOffTarget.symbol, squareOffTarget.product);

            const cr = chargeByPos.get(pkey);

            const breakdown = cr?.breakdown ?? null;

            const estCharges = breakdown != null && breakdown.totalCharges > 0 ? breakdown.totalCharges : (m?.charges ?? 0);

            const gross = m?.grossPnl ?? 0;

            const net = gross - estCharges;

            return (

              <div className="space-y-3 py-2">

                <div className="flex items-center justify-between rounded-lg bg-muted p-3">

                  <div>

                    <p className="text-sm font-semibold">{squareOffTarget.tradingSymbol || squareOffTarget.symbol}</p>

                    {squareOffTarget.companyName && <p className="text-[11px] text-muted-foreground">{squareOffTarget.companyName}</p>}

                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">

                      {squareOffTarget.side} x {squareOffTarget.netQuantity} @ {m && m.avgPrice > 0 ? fmtRs(m.avgPrice) : DASH}

                    </p>

                  </div>

                  <Badge variant={squareOffTarget.side === 'LONG' ? 'default' : 'destructive'}

                    className={squareOffTarget.side === 'LONG' ? 'border-success/30 bg-success/15 text-success' : ''}>{squareOffTarget.side}</Badge>

                </div>

                {effLtp != null && (

                  <div className="grid grid-cols-2 gap-2">

                    <div className="rounded bg-muted/50 p-2 text-center">

                      <p className="text-[10px] text-muted-foreground">Current LTP</p>

                      <p className="font-mono text-sm font-semibold tabular-nums">{fmtRs(effLtp)}</p>

                    </div>

                    {estVal != null && (

                      <div className="rounded bg-muted/50 p-2 text-center">

                        <p className="text-[10px] text-muted-foreground">Estimated Value</p>

                        <p className="font-mono text-sm font-semibold tabular-nums">{fmtRs(estVal)}</p>

                      </div>

                    )}

                  </div>

                )}

                <div className="rounded-lg border border-border/50 bg-muted/20 p-3">

                  <div className="grid grid-cols-3 gap-2 text-center">

                    <div>

                      <p className="text-[10px] text-muted-foreground">Gross P&amp;L</p>

                      <p className={cn('font-mono text-sm font-semibold tabular-nums', pnlClr(gross))}>{fmtPnl(gross)}</p>

                    </div>

                    <div>

                      <p className="text-[10px] text-muted-foreground">Est. Charges</p>

                      <p className="font-mono text-sm font-semibold tabular-nums text-destructive">{estCharges > 0 ? fmtPnl(-estCharges) : '—'}</p>

                    </div>

                    <div>

                      <p className="text-[10px] text-muted-foreground">Est. Net P&amp;L</p>

                      <p className={cn('font-mono text-sm font-semibold tabular-nums', pnlClr(net))}>{fmtPnl(net)}</p>

                    </div>

                  </div>

                  {breakdown && (

                    <p className="mt-2 text-center text-[10px] text-muted-foreground">Brokerage {fmtRs(breakdown.brokerage)} · STT {fmtRs(breakdown.stt)} · Exchange {fmtRs(breakdown.exchangeCharges)} · GST {fmtRs(breakdown.gst)}</p>

                  )}

                </div>

                <p className="text-center text-xs text-muted-foreground">

                  This will place a {squareOffTarget.side === 'LONG' ? 'SELL' : 'BUY'} market order for {squareOffTarget.netQuantity} shares at market.

                </p>

              </div>

            );

          })()}

          <DialogFooter className="gap-2">

            <Button variant="outline" onClick={() => { setSquareOffTarget(null); setSquareOffSending(false); }} disabled={squareOffSending}>Cancel</Button>

            <Button variant="destructive" onClick={() => squareOffTarget && handleSquareOff(squareOffTarget)} disabled={squareOffSending}>

              {squareOffSending ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Power className="mr-1 h-3 w-3" />}

              {squareOffSending ? 'Placing Order...' : 'Confirm Square Off'}

            </Button>

          </DialogFooter>

        </DialogContent>

      </Dialog>

    </div>

  );

}

