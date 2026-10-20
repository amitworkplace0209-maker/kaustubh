'use client';

import type { InstrumentSelection, PrecheckSummary, TicketState } from '@/components/orders/trade/types';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">
        <span className="font-semibold text-foreground tabular-nums">{v}</span>
        {sub && <span className="block text-[10px] text-muted-foreground/70 tabular-nums">{sub}</span>}
      </span>
    </div>
  );
}

/** Order preview summary shown before the order is placed. */
export function OrderPreviewSummary({
  caps,
  selection,
  ticket,
  quote,
  precheck,
  estimatedValue,
}: {
  caps: TradeCapabilities;
  selection: InstrumentSelection;
  ticket: TicketState;
  quote: { ltp: number | null; rawIsDemo: boolean } | null;
  precheck: PrecheckSummary;
  estimatedValue: number | null;
}) {
  const qty = Number(ticket.quantity) || 0;
  const price =
    ticket.orderType === 'MKT' ? (quote?.ltp ?? null) : (Number(ticket.price) || null);
  const currency = caps.virtualCurrency || quote?.rawIsDemo ? 'Coin' : caps.accountCurrency;
  const rupee = (v: number) =>
    currency === 'Coin'
      ? `${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Coins`
      : `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  return (
    <div className="divide-y divide-border/60 rounded-xl border border-border/60 px-3 py-1">
      <Row k="Instrument" v={selection.symbol} sub={`${selection.exchange} · ${selection.tradingSymbol || ''}`} />
      <Row k="Side / product" v={`${ticket.side} · ${ticket.product}`} />
      <Row k="Order type" v={ticket.orderType} sub={ticket.orderType === 'MKT' ? 'market price' : ticket.validity} />
      <Row k="Quantity" v={String(qty)} />
      {ticket.orderType !== 'MKT' && (
        <Row k="Price" v={price != null ? rupee(price) : '—'} sub={ticket.orderType.includes('SL') ? 'limit after trigger' : undefined} />
      )}
      {(ticket.orderType === 'SL' || ticket.orderType === 'SL-M') && (
        <Row k="Trigger" v={Number(ticket.triggerPrice) ? rupee(Number(ticket.triggerPrice)) : '—'} />
      )}
      {estimatedValue != null && (
        <Row
          k="Estimated value"
          v={rupee(estimatedValue)}
          sub={ticket.orderType === 'MKT' ? 'at last trade price' : 'limit value'}
        />
      )}
      <div className="py-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Risk gate ({precheck.kind})</span>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{precheck.label}</p>
      </div>
    </div>
  );
}