'use client';

import { Activity } from 'lucide-react';
import { cn } from '@/lib/utils';
import { changeTone, sign } from '@/components/design-system';
import type { InstrumentSelection, LiveQuote } from '@/components/orders/trade/types';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';

interface SelectedStockCardProps {
  selection: InstrumentSelection;
  quote: LiveQuote | null;
  caps: TradeCapabilities;
  marginRequired: number | null;
  orderValue: number | null;
  isBUY: boolean;
  availableMargin: number | null;
  quantity?: string;
  /** Local per-share margin (broker 1-qty margin when known, else price ×
   *  product factor). Lets the tile scale with quantity instantly while the
   *  server margin is still on its way. */
  perShare?: number | null;
  /** 'server' = backend-computed, 'estimate' = local per-share × qty. */
  marginSource?: 'server' | 'estimate' | null;
}

function fmtExchange(ex?: string): string {
  if (!ex) return 'NSE';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').trim().toUpperCase();
}

/** Compact Indian-locale magnitude, WITHOUT a currency glyph. */
function fmtBare(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/** Plain (₹-less) compact number for the micro OHLC row. */
function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** IST clock label for the moment a snapshot price actually belongs to. */
function fmtAsOf(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Instrument header — the one block that must never scroll away on a phone.
 *
 * Layout contract (both breakpoints, ONE block):
 *   row 1  identity ............ price
 *   row 2  company name ........ change
 *   row 3  day-range bar with the live LTP marker  +  circuit limits
 *   row 4  margin · value · available (always visible — it used to be `sm:` only)
 *
 * Everything below is real: the range bar only renders when the feed has given
 * both a day high and a day low, and the marker only when an LTP exists.
 */
export function SelectedStockCard({
  selection,
  quote,
  caps,
  marginRequired,
  orderValue,
  availableMargin,
  marginSource,
}: SelectedStockCardProps) {
  const ltp = quote?.ltp ?? selection.ltp ?? null;
  const change = quote?.change != null ? quote.change : (selection.change ?? null);
  const changePct = quote?.changePct != null ? quote.changePct : (selection.changePct ?? null);
  // "Live" means a streaming tick owns the price. A broker snapshot or a stored
  // close is a real print but NOT live — it is labelled "Last" instead of
  // dressing a stale number up as streaming.
  const live = quote?.ltp != null && !quote?.stale;
  const snapshot = quote?.ltp != null && Boolean(quote?.stale);
  const high = quote?.high ?? null;
  const low = quote?.low ?? null;
  const hasRange = high != null && low != null && Number.isFinite(high) && Number.isFinite(low) && high > low;
  const marker = hasRange && ltp != null ? Math.min(100, Math.max(0, ((ltp - low) / (high - low)) * 100)) : null;
  // Dummy Mode trades in virtual Coin, not rupees — the ticket already labels it
  // "C"; the header used to print a rupee sign, which mislabelled the account.
  const unit = caps.virtualCurrency ? 'C' : '₹';
  const asOfLabel = fmtAsOf(quote?.asOf);
  const money = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? '—' : `${unit}${fmtBare(v)}`;

  return (
    <div className="border-b border-border/40 bg-card/60 px-3 py-2.5">
      {/* ── row 1 + 2: identity and price ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider',
                live
                  ? 'bg-success/15 text-success'
                  : snapshot
                    ? 'bg-warning/15 text-warning'
                    : 'bg-muted text-muted-foreground',
              )}
              title={
                live
                  ? 'Live tick streaming'
                  : snapshot
                    ? `Snapshot price — ${quote?.source ?? 'last known'}`
                    : 'Waiting for the first price'
              }
            >
              <Activity className={cn('h-2.5 w-2.5', live && 'animate-pulse')} />
              {live ? 'Live' : snapshot ? 'Last' : 'Wait'}
            </span>
            <span className="truncate text-[17px] font-extrabold leading-tight tracking-tight">
              {selection.symbol}
            </span>
            <span className="shrink-0 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-primary">
              {fmtExchange(selection.exchangeSegment || selection.exchange)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
            {selection.companyName || selection.tradingSymbol || '—'}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p
            className={cn(
              'font-mono text-[24px] font-extrabold leading-none tabular-nums tracking-tight sm:text-[26px]',
              changeTone(changePct),
            )}
          >
            {ltp != null
              ? `${unit}${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '—'}
          </p>
          <p
            className={cn(
              'mt-0.5 font-mono text-[11px] font-bold leading-tight tabular-nums',
              changeTone(changePct),
            )}
          >
            {change != null ? `${sign(change)}${change.toFixed(2)}` : '—'}
            {changePct != null && <span className="ml-1">({sign(changePct)}{changePct.toFixed(2)}%)</span>}
          </p>
        </div>
      </div>

      {/* ── row 3: day range + circuits ── */}
      <div className="mt-2">
        <div className="flex items-center justify-between font-mono text-[9px] tabular-nums text-muted-foreground">
          <span>L {low != null ? fmtNum(low) : '—'}</span>
          <span className="flex items-center gap-2">
            <span>V {quote?.volume != null ? fmtNum(quote.volume) : '—'}</span>
          </span>
          <span>H {high != null ? fmtNum(high) : '—'}</span>
        </div>
        {hasRange ? (
          <div
            className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gradient-to-r from-destructive/40 via-warning/30 to-success/40"
            role="img"
            aria-label={
              ltp != null
                ? `Day range ${low} to ${high}, live price ${ltp}`
                : `Day range ${low} to ${high}`
            }
          >
            {marker != null && (
              <span
                className="absolute top-1/2 h-3 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_hsl(var(--card))]"
                style={{ left: `${marker}%` }}
              />
            )}
          </div>
        ) : (
          <div className="mt-1 h-1.5 w-full rounded-full bg-muted/40" aria-hidden />
        )}
        <div className="mt-1 flex items-center justify-between font-mono text-[9px] font-semibold tabular-nums">
          <span className="text-destructive">
            LC {quote?.lowerCircuit != null ? fmtNum(quote.lowerCircuit) : '—'}
          </span>
          <span className="text-success">
            UC {quote?.upperCircuit != null ? fmtNum(quote.upperCircuit) : '—'}
          </span>
        </div>
        {snapshot && (
          <p className="mt-1 truncate font-mono text-[9px] leading-tight text-muted-foreground" title="The price is a real print, but not a streaming tick — labelled honestly">
            {quote?.source ?? 'last known'}
            {(quote?.sourceId === 'last_close' || quote?.sourceId === 'channel_snapshot') && asOfLabel
              ? ` · ${asOfLabel}`
              : ''}
          </p>
        )}
      </div>

      {/* ── row 4: money snapshot — visible at EVERY breakpoint ── */}
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {[
          { label: 'Margin', value: marginRequired, tone: 'text-warning', suffix: marginSource === 'estimate' ? 'est' : null },
          { label: 'Value', value: orderValue, tone: 'text-foreground', suffix: null },
          { label: 'Avail', value: availableMargin, tone: 'text-success', suffix: null },
        ].map((m) => (
          <div key={m.label} className="rounded-lg border border-border/50 bg-muted/25 px-2 py-1">
            <p className="text-[8px] font-bold uppercase tracking-wider text-muted-foreground">{m.label}</p>
            <p className={cn('font-mono text-[12px] font-bold leading-tight tabular-nums', m.tone)}>
              {money(m.value)}
              {m.suffix && <span className="ml-0.5 text-[8px] text-muted-foreground">{m.suffix}</span>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}