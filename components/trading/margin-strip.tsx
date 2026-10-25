'use client';

import { memo } from 'react';
import { PiggyBank, TrendingDown, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MarginStripProps {
  currency: string;
  /** Margin this order needs (server figure when available). */
  required: number | null;
  /** 'server' = broker margin API, 'estimate' = locally derived. */
  requiredSource: 'server' | 'estimate' | null;
  available: number | null;
  /** Available minus required. */
  remaining: number | null;
  orderValue: number | null;
}

/**
 * The money strip — margin, available, after, value.
 *
 * An unknown number renders as `—`, never as `0`. A locally derived margin is
 * labelled `est` so it can never be mistaken for the broker's own figure.
 */
export const MarginStrip = memo(function MarginStrip({
  currency,
  required,
  requiredSource,
  available,
  remaining,
  orderValue,
}: MarginStripProps) {
  const money = (v: number | null | undefined, digits = 0) =>
    v == null || !Number.isFinite(v)
      ? '—'
      : `${currency}${v.toLocaleString('en-IN', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}`;

  return (
    <div className="grid grid-cols-2 gap-px border-t border-border/50 bg-border/40 sm:grid-cols-4">
      <Tile
        icon={<Wallet className="h-3.5 w-3.5" />}
        label="Margin"
        value={money(required)}
        hint={requiredSource === 'estimate' ? 'estimate' : requiredSource === 'server' ? 'broker' : undefined}
        tone={requiredSource === 'estimate' ? 'warning' : 'default'}
      />
      <Tile icon={<PiggyBank className="h-3.5 w-3.5" />} label="Available" value={money(available)} tone="success" />
      <Tile
        icon={<TrendingDown className="h-3.5 w-3.5" />}
        label="After"
        value={money(remaining)}
        tone={remaining != null && remaining < 0 ? 'danger' : 'default'}
      />
      <Tile label="Order value" value={money(orderValue, 2)} />
    </div>
  );
});

function Tile({
  icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const valueClass = {
    default: 'text-foreground',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
  }[tone];
  return (
    <div className="bg-card px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn('mt-0.5 font-mono text-[14px] font-bold tabular-nums', valueClass)}>
        {value}
        {hint && <span className="ml-1 text-[10px] font-semibold uppercase text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}
