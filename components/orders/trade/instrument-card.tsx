'use client';

import { Activity, Database, Star, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionCard, StatusBadge, changeTone, fmtNumber, sign } from '@/components/design-system';
import type { InstrumentSelection, LiveQuote } from '@/components/orders/trade/types';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';

function formatINR(val: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

function formatVolume(val: number): string {
  if (val >= 1e7) return `${(val / 1e7).toFixed(2)}Cr`;
  if (val >= 1e5) return `${(val / 1e5).toFixed(2)}L`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`;
  return val.toLocaleString('en-IN');
}

function formatExchange(ex?: string): string {
  if (!ex) return '—';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').toUpperCase();
}

/** Instrument card — the single source of live price truth for the ticket.
 *  LTP comes ONLY from the backend realtime 'trading' channel over WS#3
 *  (connection_engine fan-out of the live market feed); when no tick is
 *  available the card shows an honest '—' + offline/pending state. */
export function InstrumentCard({
  selection,
  caps,
  quote,
  activeSide,
  onChooseSide,
}: {
  selection: InstrumentSelection;
  caps: TradeCapabilities;
  quote: LiveQuote | null;
  activeSide?: 'BUY' | 'SELL';
  onChooseSide?: (side: 'BUY' | 'SELL') => void;
}) {
  const isDemoQuote = Boolean(quote?.raw.isDemo) || caps.virtualCurrency;
  const currency = isDemoQuote ? 'Coin' : caps.accountCurrency;
  const ltp = quote?.ltp ?? selection.ltp ?? null;
  const prevClose = quote?.close ?? selection.prevClose ?? null;
  const change = quote?.change != null
    ? quote.change
    : (prevClose != null && ltp != null ? ltp - prevClose : null);
  const changePct = quote?.changePct != null
    ? quote.changePct
    : (prevClose != null && prevClose !== 0 && ltp != null ? ((ltp - prevClose) / prevClose) * 100 : null);
  const live = quote
    ? quote.stale
      ? { tone: 'warning' as const, label: 'STALE TICK' }
      : ltp != null
        ? { tone: 'success' as const, label: 'LIVE TICK' }
        : { tone: 'info' as const, label: 'QUOTE PENDING' }
    : { tone: 'warning' as const, label: 'NO QUOTE YET' };

  const dirState = change != null && change > 0 ? 'up' : change != null && change < 0 ? 'down' : 'flat';

  const bestBid = quote?.raw?.depth?.buy?.[0]?.price ?? null;
  const bestAsk = quote?.raw?.depth?.sell?.[0]?.price ?? null;
  const bestBidQty = quote?.raw?.depth?.buy?.[0]?.quantity ?? null;
  const bestAskQty = quote?.raw?.depth?.sell?.[0]?.quantity ?? null;

  return (
    <SectionCard
      title={selection.symbol}
      headerRight={<StatusBadge status={live.tone} label={live.label} />}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">
            {selection.companyName || selection.tradingSymbol || '—'}
          </p>
          <div className="mt-1 flex items-baseline gap-2.5">
            <span className="text-3xl font-bold tabular-nums tracking-tight">
              {ltp != null
                ? formatINR(ltp)
                : '—'}
            </span>
            {change != null && changePct != null && (
              <span className={cn('text-sm font-semibold tabular-nums', changeTone(change))}>
                {sign(change)}{change.toFixed(2)} ({sign(changePct)}{changePct.toFixed(2)}%)
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
            {formatExchange(selection.exchangeSegment || selection.exchange)}
          </span>
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
            {selection.instrumentType || 'EQ'}
          </span>
          <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
            {caps.modeLabel}
          </span>
        </div>
      </div>

      {/* OHLC Grid */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Open</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">{quote?.open != null ? formatINR(quote.open) : '—'}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">High</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-success">{quote?.high != null ? formatINR(quote.high) : '—'}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Low</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-destructive">{quote?.low != null ? formatINR(quote.low) : '—'}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Prev Close</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">{prevClose != null ? formatINR(prevClose) : '—'}</p>
        </div>
      </div>

      {/* Bid/Ask */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Bid</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-success">
            {bestBid != null ? formatINR(bestBid) : '—'}
            {bestBidQty != null && <span className="text-[10px] text-muted-foreground ml-1">×{fmtNumber(bestBidQty)}</span>}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Ask</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-destructive">
            {bestAsk != null ? formatINR(bestAsk) : '—'}
            {bestAskQty != null && <span className="text-[10px] text-muted-foreground ml-1">×{fmtNumber(bestAskQty)}</span>}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Volume</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">{quote?.volume != null ? formatVolume(quote.volume) : '—'}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">OI</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">
            {quote?.raw?.open_interest != null ? fmtNumber(quote.raw.open_interest) : '—'}
          </p>
        </div>
      </div>

      {/* Circuit */}
      {(quote?.upperCircuit || quote?.lowerCircuit) && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <TrendingDown className="h-3 w-3 text-destructive" />
            <span className="text-muted-foreground">Lower Circuit</span>
            <span className="font-mono font-semibold text-destructive">{quote.lowerCircuit ? formatINR(quote.lowerCircuit) : '—'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Upper Circuit</span>
            <span className="font-mono font-semibold text-success">{quote.upperCircuit ? formatINR(quote.upperCircuit) : '—'}</span>
            <TrendingUp className="h-3 w-3 text-success" />
          </div>
        </div>
      )}

      {/* Margin */}
      {selection.oneQtyMargin != null && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-success/20 bg-success/[0.04] px-3 py-2 text-xs">
          <span className="font-medium text-muted-foreground">1-Qty Margin:</span>
          <span className="font-mono font-semibold text-success">{formatINR(selection.oneQtyMargin)}</span>
        </div>
      )}

      {/* BUY / SELL buttons */}
      {onChooseSide && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(['BUY', 'SELL'] as const).map((side) => (
            <button
              key={side}
              type="button"
              onClick={() => onChooseSide(side)}
              aria-pressed={activeSide === side}
              className={cn(
                'h-10 rounded-lg text-sm font-bold uppercase tracking-wide transition-colors',
                side === 'BUY'
                  ? activeSide === 'BUY'
                    ? 'bg-success text-success-foreground shadow-sm'
                    : 'border border-success/50 bg-success/10 text-success hover:bg-success/20'
                  : activeSide === 'SELL'
                    ? 'bg-destructive text-destructive-foreground shadow-sm'
                    : 'border border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/20',
              )}
            >
              {side}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/60 pt-3 text-[10px] text-muted-foreground">
        <span className="mr-1 inline-flex items-center gap-1 font-semibold uppercase tracking-wider">
          <Database className="h-3 w-3" /> capabilities
        </span>
        {caps.products.map((p) => (
          <span key={p} className="rounded border border-border px-1.5 py-0.5">{p}</span>
        ))}
        {caps.orderTypes.map((o) => (
          <span key={o} className="rounded border border-border px-1.5 py-0.5">{o}</span>
        ))}
        <Star className="ml-auto h-3 w-3 text-muted-foreground/40" />
      </div>

      {/* Data source + status */}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className={cn('h-1.5 w-1.5 rounded-full', quote?.ltp ? (quote.stale ? 'bg-warning animate-pulse' : 'bg-success animate-pulse') : 'bg-destructive')} />
        {isDemoQuote ? 'Dummy Engine LTP' : 'Broker Quote'}
        {quote && (
          <>
            <span className="text-muted-foreground/60">·</span>
            <span className="tabular-nums">
              {quote.stale ? 'stale last known' : quote.ts ? new Date(quote.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—'}
            </span>
          </>
        )}
        {selection.tickAgeSeconds != null && (
          <span className="text-muted-foreground/60">· {selection.tickAgeSeconds}s old</span>
        )}
      </div>
    </SectionCard>
  );
}
