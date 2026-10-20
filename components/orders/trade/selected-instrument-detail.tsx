'use client';

import { memo } from 'react';
import { Gauge, ShieldAlert, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { changeTone, sign, StatusBadge } from '@/components/design-system';
import type { InstrumentSelection, LiveQuote } from '@/components/orders/trade/types';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';

function fmtINR(val: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}
function fmtExchange(ex?: string): string {
  if (!ex) return 'NSE';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').toUpperCase();
}
function StatBlock({ icon: Icon, label, value, tone, sub }: { icon: any; label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-gradient-to-b from-card to-muted/20 px-3 py-3 shadow-sm">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className={cn('mt-1 text-lg font-extrabold tabular-nums tracking-tight', tone)}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  );
}

export const SelectedInstrumentLiveDetail = memo(function SelectedInstrumentLiveDetail({
  selection,
  caps,
  quote,
  quantity,
  orderValue,
}: {
  selection: InstrumentSelection;
  caps: TradeCapabilities;
  quote: LiveQuote | null;
  quantity?: string;
  orderValue?: number | null;
}) {
  const ltp = quote?.ltp ?? selection.ltp ?? null;
  const prevClose = quote?.close ?? selection.prevClose ?? null;
  const change = quote?.change != null ? quote.change : (prevClose != null && ltp != null ? ltp - prevClose : null);
  const changePct = quote?.changePct != null ? quote.changePct : (prevClose != null && prevClose !== 0 && ltp != null ? ((ltp - prevClose) / prevClose) * 100 : null);
  const isDemoQuote = Boolean(quote?.raw?.isDemo) || caps.virtualCurrency;
  const currency = isDemoQuote ? 'Coin' : '₹';
  const money = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return '—';
    if (currency === 'Coin') return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    return fmtINR(v);
  };
  const upperCircuit = quote?.upperCircuit ?? selection.upperCircuit ?? null;
  const lowerCircuit = quote?.lowerCircuit ?? selection.lowerCircuit ?? null;
  const oneQtyMargin = selection.oneQtyMargin ?? null;
  const live = quote ? (quote.stale ? { tone: 'warning' as const, label: 'STALE' } : ltp != null ? { tone: 'success' as const, label: 'LIVE' } : { tone: 'info' as const, label: 'PENDING' }) : { tone: 'warning' as const, label: 'NO QUOTE' };
  const marginValue = oneQtyMargin ?? ltp;
  const marginSub = oneQtyMargin != null ? 'engine margin' : ltp != null ? '≈ live price' : '—';

  const qtyNum = quantity ? parseInt(quantity, 10) : null;
  const qtyValid = qtyNum != null && Number.isInteger(qtyNum) && qtyNum >= 1;
  const oneQtyPrice = ltp != null ? ltp : null;
  const totalForQty = qtyValid && oneQtyPrice != null ? qtyNum! * oneQtyPrice : null;

  return (
    <section data-verify="selected-live-detail" className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-soft">
      {/* Header — Stock Name, exchange, live quote state */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-gradient-to-r from-primary/[0.04] via-card to-success/[0.04] px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-extrabold tracking-tight">{selection.symbol}</span>
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">{fmtExchange(selection.exchangeSegment || selection.exchange)}</span>
            {selection.instrumentType && (
              <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{selection.instrumentType}</span>
            )}
            {isDemoQuote && (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-warning">Paper Trade</span>
            )}
          </div>
          <p className="mt-1 line-clamp-1 text-[11px] font-medium text-muted-foreground">
            {selection.companyName || selection.tradingSymbol || (selection.isin ? `ISIN ${selection.isin}` : '—')} · {caps.modeLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {change != null && (
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ring-1', change >= 0 ? 'bg-success/10 text-success ring-success/20' : 'bg-destructive/10 text-destructive ring-destructive/20')}>
              {change >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              {sign(change)}{change.toFixed(2)} {changePct != null ? `(${sign(changePct)}${changePct.toFixed(2)}%)` : ''}
            </span>
          )}
          <StatusBadge status={live.tone} label={live.label} />
        </div>
      </div>

      {/* Only the five facts the trade desk needs — Live Price, 1 Qty margin, circuits */}
      <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4">
        <StatBlock
          icon={Gauge}
          label="Live Price"
          value={money(ltp)}
          tone={changePct != null ? changeTone(changePct) : undefined}
          sub={quote?.ts ? `as of ${new Date(quote.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}` : 'market-watch live'}
        />
        <StatBlock
          icon={ShieldCheck}
          label="Margin / 1 Qty"
          value={money(marginValue)}
          tone={oneQtyMargin != null ? 'text-success' : undefined}
          sub={marginSub}
        />
        <StatBlock
          icon={TrendingUp}
          label="Upper Circuit"
          value={upperCircuit ? money(upperCircuit) : '—'}
          tone={upperCircuit ? 'text-success' : undefined}
          sub={upperCircuit ? 'price band high' : undefined}
        />
        <StatBlock
          icon={ShieldAlert}
          label="Lower Circuit"
          value={lowerCircuit ? money(lowerCircuit) : '—'}
          tone={lowerCircuit ? 'text-destructive' : undefined}
          sub={lowerCircuit ? 'price band low' : undefined}
        />
      </div>

      {/* One-line order value hint (1 qty × qty) — real math, no scroll needed */}
      {oneQtyPrice != null && (
        <div className="border-t border-border/40 bg-muted/30 px-4 py-2 text-[11px] tabular-nums text-muted-foreground">
          {qtyValid && totalForQty != null ? (
            <>
              Order value · <span className="font-bold text-foreground">{money(totalForQty)}</span>
              <span className="mx-1 text-muted-foreground/60">·</span>
              <span className="font-mono">{qtyNum} × {money(oneQtyPrice)}</span>
              {orderValue != null && orderValue > 0 && orderValue !== totalForQty && (
                <>
                  <span className="mx-1 text-muted-foreground/60">·</span> engine {money(orderValue)}
                </>
              )}
            </>
          ) : (
            <>1-qty price · <span className="font-bold text-foreground">{money(oneQtyPrice)}</span> — multiply by quantity for the order value</>
          )}
        </div>
      )}
    </section>
  );
});