'use client';

import { Boxes, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InstrumentSelection, TicketState } from '@/components/orders/trade/types';

export interface BasketPanelProps {
  legs: Array<{ id: string; selection: InstrumentSelection; ticket: TicketState; addedAt: number }>;
  name: string;
  onName: (name: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  currency: string;
}

/**
 * The basket — legs queued from this ticket.
 *
 * The legs are handed to the basket workspace through `setBasketDraft`, which
 * is the only handoff the basket page reads.
 */
export function BasketPanel({
  legs,
  name,
  onName,
  onAdd,
  onRemove,
  onClear,
  currency,
}: BasketPanelProps) {
  return (
    <section className="rounded-xl border border-border/70 bg-card p-3">
      <header className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
        <Boxes className="h-3.5 w-3.5" />
        Basket · {legs.length} leg{legs.length === 1 ? '' : 's'}
      </header>

      <Input
        aria-label="Basket name"
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Basket name"
        className="mt-2 h-9 text-[13px] font-semibold"
      />

      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onAdd}
        className="mt-2 h-9 w-full rounded-lg border-primary/30 bg-primary/5 text-[12px] font-bold text-primary hover:bg-primary/10"
      >
        <Plus className="h-3.5 w-3.5" /> Add the current ticket
      </Button>

      {legs.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-foreground">
          No legs yet. Add the current ticket to build a basket, then send it from the basket
          workspace.
        </p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {legs.map((leg) => (
              <li
                key={leg.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/25 px-2.5 py-1.5 text-[12px]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-mono font-bold">{leg.selection.symbol}</span>
                  <span className="block tabular-nums text-muted-foreground">
                    {leg.ticket.side} · {leg.ticket.quantity} × {leg.ticket.orderType} ·{' '}
                    {leg.ticket.product}
                    {leg.ticket.price ? ` @ ${currency}${Number(leg.ticket.price).toFixed(2)}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${leg.selection.symbol}`}
                  onClick={() => onRemove(leg.id)}
                  className="shrink-0 rounded-md border border-border/60 p-1.5 text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClear}
            className="mt-2 h-8 w-full text-[12px] font-semibold text-muted-foreground"
          >
            Clear basket
          </Button>
        </>
      )}
    </section>
  );
}
