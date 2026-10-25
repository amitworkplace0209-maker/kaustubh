'use client';

import { memo } from 'react';
import { Activity, Building2, Layers, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InstrumentSelection, LiveQuote } from '@/components/orders/trade/types';

export interface QuoteHeaderProps {
  selection: InstrumentSelection;
  quote: LiveQuote | null;
  currency: string;
}

function money(v: number | null | undefined, currency: string, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${currency}${v.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function compact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString('en-IN');
}

/**
 * The instrument header — the price, in the foreground.
 *
 * It shows WHAT the price is (live stream / broker print / tick-store
 * snapshot / search snapshot) so the operator always knows whether the number
 * in front of them is streaming or a stored print. Nothing is derived: the
 * circuit limits come from the tick store, never from the LTP.
 */
export const QuoteHeader = memo(function QuoteHeader({ selection, quote, currency }: QuoteHeaderProps) {
  const ltp = quote?.ltp ?? null;
  const change = quote?.change ?? null;
  const changePct = quote?.changePct ?? null;
  const up = (change ?? 0) >= 0;

  const low = quote?.lowerCircuit ?? quote?.low ?? null;
  const high = quote?.upperCircuit ?? quote?.high ?? null;
  const dayLow = quote?.low ?? null;
  const dayHigh = quote?.high ?? null;
  const markerPct =
    ltp != null && low != null && high != null && high > low
      ? Math.min(100, Math.max(0, ((ltp - low) / (high - low)) * 100))
      : null;

  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/50 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[18px] font-extrabold leading-tight tracking-tight">
              {selection.tradingSymbol || selection.symbol}
            </h1>
            <span className="rounded border border-border px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {selection.exchangeSegment || selection.exchange}
            </span>
            {quote?.stale ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning">
                snapshot
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-success">
                <Activity className="h-3 w-3" /> live
              </span>
            )}
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 truncate text-[12px] text-muted-foreground">
            {selection.companyName && <span className="truncate">{selection.companyName}</span>}
            {selection.instrumentType && (
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {selection.instrumentType}
              </span>
            )}
            {selection.lotSize != null && (
              <span className="inline-flex items-center gap-1">
                <Layers className="h-3 w-3" />
                lot {selection.lotSize}
              </span>
            )}
          </p>
        </div>

        <div className="text-right">
          <div className="font-mono text-[28px] font-extrabold leading-none tabular-nums tracking-tight">
            {money(ltp, currency)}
          </div>
          <div
            className={cn(
              'mt-1 flex items-center justify-end gap-1 font-mono text-[13px] font-bold tabular-nums',
              up ? 'text-success' : 'text-destructive',
            )}
          >
            {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {change != null ? `${up ? '+' : ''}${change.toFixed(2)}` : '—'}
            {changePct != null && <span>({up ? '+' : ''}{changePct.toFixed(2)}%)</span>}
          </div>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {quote?.source ?? 'waiting for a price'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-border/40 sm:grid-cols-6">
        <Stat label="Open" value={money(quote?.open ?? null, currency)} />
        <Stat label="High" value={money(quote?.high ?? null, currency)} />
        <Stat label="Low" value={money(quote?.low ?? null, currency)} />
        <Stat label="Prev close" value={money(quote?.close ?? null, currency)} />
        <Stat label="Volume" value={compact(quote?.volume ?? null)} />
        <Stat
          label="Circuits"
          value={
            quote?.lowerCircuit != null || quote?.upperCircuit != null
              ? `${money(quote?.lowerCircuit ?? null, currency, 1)} – ${money(quote?.upperCircuit ?? null, currency, 1)}`
              : '—'
          }
        />
      </div>

      {markerPct != null && (
        <div className="px-3 pb-3 pt-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full',
                up ? 'bg-success/70' : 'bg-destructive/70',
              )}
              style={{ width: `${markerPct}%` }}
            />
            <span
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground shadow"
              style={{ left: `${markerPct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>{money(dayLow ?? low, currency)}</span>
            <span>{money(dayHigh ?? high, currency)}</span>
          </div>
        </div>
      )}
    </section>
  );
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-[13px] font-bold tabular-nums">{value}</div>
    </div>
  );
}
