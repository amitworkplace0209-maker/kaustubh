'use client';

import { useMemo } from 'react';
import { Calculator } from 'lucide-react';
import { calculateCharges, CALCULATION_VERSION } from '@/lib/charge-engine';
import type { InstrumentSelection, LiveQuote, TicketState } from '@/components/orders/trade/types';

export interface ChargesPanelProps {
  ticket: TicketState;
  quote: LiveQuote | null;
  selection: InstrumentSelection;
  currency: string;
}

/**
 * Charge estimate for the ticket.
 *
 * It uses the APP's canonical charge engine (`lib/charge-engine.ts`) — the same
 * module the dashboard, positions, history and calculator use — with the
 * statutory rates in `config/statutory-charges.ts` and the brokerage plan in
 * `config/brokerage.ts`.
 *
 * The engine models EQUITY only. A non-equity product (NRML) therefore has no
 * honest estimate and is reported as such instead of being priced with the
 * wrong segment.
 */
export function ChargesPanel({ ticket, quote, selection, currency }: ChargesPanelProps) {
  const qty = Number(ticket.quantity);
  const price = ticket.orderType === 'L' || ticket.orderType === 'SL'
    ? Number(ticket.price)
    : (quote?.ltp ?? 0);

  const calc = useMemo(() => {
    if (!Number.isInteger(qty) || qty < 1 || !(price > 0)) return null;
    // CASH is full-payment DELIVERY in this platform (margin factor 1.0, it
    // settles into holdings) — map it onto the engine's delivery vocabulary.
    const product = ticket.product === 'CASH' ? 'CNC' : ticket.product;
    if (product !== 'MIS' && product !== 'CNC') return null;
    return calculateCharges({
      side: ticket.side,
      quantity: qty,
      price,
      product,
      exchange: selection.exchange,
    });
  }, [qty, price, ticket.side, ticket.product, selection.exchange]);

  if (!calc) {
    return (
      <section className="rounded-xl border border-border/70 bg-card p-3">
        <Header />
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          {!(Number.isInteger(qty) && qty > 0) || !(price > 0)
            ? 'Enter a quantity and wait for a live price — charges are computed from the order value.'
            : `The configured charge model covers equity products only (MIS / CNC). ${ticket.product} is not priced here.`}
        </p>
      </section>
    );
  }

  const rows: Array<[string, number]> = [
    ['Brokerage', calc.brokerage],
    ['STT', calc.stt],
    ['Exchange txn', calc.exchangeTransactionCharges],
    ['SEBI', calc.sebiCharges],
    ['Stamp duty', calc.stampDuty],
    ['GST', calc.gst],
  ];

  return (
    <section className="rounded-xl border border-border/70 bg-card p-3">
      <Header />
      <div className="mt-2 space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between text-[12px]">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono tabular-nums">
              {value.toFixed(2)}
            </span>
          </div>
        ))}
        <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-1.5 text-[13px]">
          <span className="font-semibold">Total charges</span>
          <span className="font-mono text-[14px] font-bold tabular-nums">
            {currency}
            {calc.totalCharges.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">Turnover</span>
          <span className="font-mono tabular-nums">
            {currency}
            {calc.turnover.toFixed(2)}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
        Estimated from the configured rates (engine {CALCULATION_VERSION}). The broker&apos;s own
        contract charges the final amount.
      </p>
    </section>
  );
}

function Header() {
  return (
    <header className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
      <Calculator className="h-3.5 w-3.5" />
      Charges
    </header>
  );
}
