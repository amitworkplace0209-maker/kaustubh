'use client';

import { memo } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { SIDE_CLASS } from '@/components/orders/trade/capabilities';
import type { InstrumentSelection, LiveQuote, TicketState } from '@/components/orders/trade/types';

export interface ConfirmOrderDialogProps {
  selection: InstrumentSelection;
  ticket: TicketState;
  quote: LiveQuote | null;
  currency: string;
  requiredMargin: number | null;
  orderValue: number | null;
  placing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The review step — the last screen before the order leaves.
 *
 * It shows exactly what will be sent: instrument, side, product, order type,
 * quantity, price, trigger and the money. Nothing is added here that the
 * engine did not compute.
 */
export const ConfirmOrderDialog = memo(function ConfirmOrderDialog({
  selection,
  ticket,
  quote,
  currency,
  requiredMargin,
  orderValue,
  placing,
  onCancel,
  onConfirm,
}: ConfirmOrderDialogProps) {
  const money = (v: number | null | undefined, digits = 2) =>
    v == null || !Number.isFinite(v)
      ? '—'
      : `${currency}${v.toLocaleString('en-IN', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}`;

  const needsPrice = ticket.orderType === 'L' || ticket.orderType === 'SL';
  const needsTrigger = ticket.orderType === 'SL' || ticket.orderType === 'SL-M';

  const rows: Array<[string, string]> = [
    ['Quantity', ticket.quantity],
    ['Execution', needsPrice ? `Limit ${money(Number(ticket.price))}` : 'Market'],
    ['Trigger', needsTrigger ? money(Number(ticket.triggerPrice)) : '—'],
    ['LTP', money(quote?.ltp ?? null)],
    ['Order value', money(orderValue)],
    ['Margin', requiredMargin != null ? money(requiredMargin) : 'unavailable'],
    ['Product', ticket.product],
    ['Validity', ticket.validity],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Review order"
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-bold tracking-tight">Review order</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-md border border-border/60 p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div
            className={cn(
              'rounded-lg border p-3',
              ticket.side === 'BUY'
                ? 'border-success/30 bg-success/[0.08]'
                : 'border-destructive/30 bg-destructive/[0.08]',
            )}
          >
            <div
              className={cn(
                'text-[18px] font-extrabold tracking-tight',
                ticket.side === 'BUY' ? 'text-success' : 'text-destructive',
              )}
            >
              {ticket.side} {selection.tradingSymbol || selection.symbol}
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {selection.exchangeSegment || selection.exchange} · {ticket.product} ·{' '}
              {ticket.orderType} · {ticket.validity}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  {k}
                </dt>
                <dd className="font-mono text-[13px] font-bold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <p className="rounded-lg border border-warning/25 bg-warning/[0.08] px-3 py-2 text-[12px] text-warning">
            This order will be sent to the exchange. Please confirm.
          </p>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={placing}
              className="h-12 flex-1 rounded-lg text-[13px] font-semibold"
            >
              Back
            </Button>
            <Button
              type="button"
              onClick={onConfirm}
              disabled={placing}
              className={cn(SIDE_CLASS[ticket.side], 'h-12 flex-1 gap-1.5 rounded-lg text-[13px] font-bold')}
            >
              {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirm {ticket.side}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});
