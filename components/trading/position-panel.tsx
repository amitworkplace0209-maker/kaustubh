'use client';

import { TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pnlTone } from '@/components/design-system';
import type { LiveQuote } from '@/components/orders/trade/types';

export interface PositionPanelProps {
  position: { symbol: string; netQty: number | null; avg: number | null; ltp: number | null; pnl: number | null } | null;
  quote: LiveQuote | null;
  currency: string;
}

/**
 * The open position for the selected instrument.
 *
 * Everything shown is the broker's / paper engine's own position row. The
 * unrealised P&L is the reported one — it is never recomputed from a price
 * the page guessed.
 */
export function PositionPanel({ position, quote, currency }: PositionPanelProps) {
  const money = (v: number | null | undefined, digits = 2) =>
    v == null || !Number.isFinite(v)
      ? '—'
      : `${currency}${v.toLocaleString('en-IN', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}`;

  if (!position || position.netQty == null || position.netQty === 0) {
    return (
      <section className="rounded-xl border border-border/70 bg-card p-3">
        <header className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
          <TrendingUp className="h-3.5 w-3.5" />
          Position
        </header>
        <p className="mt-2 text-[12px] text-muted-foreground">
          No open position on this instrument.
        </p>
      </section>
    );
  }

  const long = position.netQty > 0;
  const pnlToneName = pnlTone(position.pnl);
  const pnlToneClass =
    pnlToneName === 'success' ? 'success' : pnlToneName === 'danger' ? 'danger' : 'neutral';

  return (
    <section className="rounded-xl border border-border/70 bg-card p-3">
      <header className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
        <TrendingUp className="h-3.5 w-3.5" />
        Position
      </header>
      <div className="mt-2 flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono text-[22px] font-extrabold tabular-nums',
            long ? 'text-success' : 'text-destructive',
          )}
        >
          {long ? '+' : ''}
          {position.netQty}
        </span>
        <span className="rounded border border-border px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {long ? 'long' : 'short'}
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-[12px]">
        <Row label="Average" value={money(position.avg)} />
        <Row label="LTP" value={money(quote?.ltp ?? position.ltp)} />
        <Row
          label="Unrealised P&L"
          value={money(position.pnl)}
          tone={position.pnl != null ? pnlToneClass : undefined}
        />
      </dl>
    </section>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'danger' | 'neutral' | 'warning' | 'info';
}) {
  const toneClass =
    tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : 'text-foreground';  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-mono font-bold tabular-nums', toneClass)}>{value}</dd>
    </div>
  );
}
