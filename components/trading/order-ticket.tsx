'use client';

import { memo } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { VALIDITIES } from '@/components/orders/trade/lifecycle';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';
import type { InstrumentSelection, LiveQuote, OrderSide, TicketState } from '@/components/orders/trade/types';

export interface OrderTicketCardProps {
  caps: TradeCapabilities;
  ticket: TicketState;
  onChange: (next: TicketState) => void;
  quote: LiveQuote | null;
  selection: InstrumentSelection;
  lotSize: number;
  perShare: number | null;
  disabled?: boolean;
}

const SIDES: OrderSide[] = ['BUY', 'SELL'];

/**
 * The order ticket.
 *
 * The order types and products it offers come from the BACKEND capability
 * registry (`caps.orderTypes` / `caps.products`), so the page can never offer
 * a combination the broker's SDK does not support.
 */
export const OrderTicketCard = memo(function OrderTicketCard({
  caps,
  ticket,
  onChange,
  quote,
  selection,
  lotSize,
  perShare,
  disabled,
}: OrderTicketCardProps) {
  const needsPrice = ticket.orderType === 'L' || ticket.orderType === 'SL';
  const needsTrigger = ticket.orderType === 'SL' || ticket.orderType === 'SL-M';
  const qty = Number(ticket.quantity);
  const validQty = Number.isInteger(qty) && qty > 0;

  const setQty = (next: number) => {
    const clamped = Math.max(1, Math.floor(next));
    onChange({ ...ticket, quantity: String(clamped) });
  };

  const stepQty = (dir: 1 | -1) => {
    const base = validQty ? qty : 0;
    setQty(base + dir * lotSize);
  };

  const setAmount = (value: string) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0 || perShare == null || perShare <= 0) {
      onChange({ ...ticket, amount: value });
      return;
    }
    const sized = quantityFromMarginSafe(amount, perShare, lotSize);
    onChange({ ...ticket, amount: value, quantity: sized != null ? String(sized) : ticket.quantity });
  };

  return (
    <div className="space-y-2.5 p-3">
      {/* side */}
      <Segmented
        value={ticket.side}
        options={SIDES.map((s) => ({ value: s, label: s }))}
        onChange={(side) => onChange({ ...ticket, side: side as OrderSide })}
        disabled={disabled}
        tone="side"
      />

      {/* order type */}
      <Field label="Order type">
        <Segmented
          value={ticket.orderType}
          options={caps.orderTypes.map((t) => ({ value: t, label: t }))}
          onChange={(orderType) => onChange({ ...ticket, orderType })}
          disabled={disabled}
        />
      </Field>

      {/* product + validity */}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="Product">
          <Segmented
            value={ticket.product}
            options={caps.products.map((p) => ({ value: p, label: p }))}
            onChange={(product) => onChange({ ...ticket, product })}
            disabled={disabled}
          />
        </Field>
        <Field label="Validity">
          <Segmented
            value={ticket.validity}
            options={VALIDITIES.map((v) => ({ value: v, label: v }))}
            onChange={(validity) => onChange({ ...ticket, validity })}
            disabled={disabled}
          />
        </Field>
      </div>

      {/* quantity + margin amount */}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label={`Quantity${lotSize > 1 ? ` (lot ${lotSize})` : ''}`}>
          <div className="flex items-stretch overflow-hidden rounded-lg border border-border bg-background">
            <button
              type="button"
              aria-label="Decrease quantity"
              disabled={disabled || !validQty || qty <= lotSize}
              onClick={() => stepQty(-1)}
              className="flex w-11 items-center justify-center border-r border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              <Minus className="h-4 w-4" />
            </button>
            <input
              aria-label="Quantity"
              inputMode="numeric"
              value={ticket.quantity}
              disabled={disabled}
              onChange={(e) => onChange({ ...ticket, quantity: e.target.value.replace(/[^\d]/g, '') })}
              className="h-11 min-w-0 flex-1 bg-transparent px-3 text-center font-mono text-[16px] font-bold tabular-nums outline-none"
            />
            <button
              type="button"
              aria-label="Increase quantity"
              disabled={disabled}
              onClick={() => stepQty(1)}
              className="flex w-11 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </Field>

        <Field
          label="Margin to commit"
          hint={
            perShare != null && perShare > 0
              ? `${ticket.product} ≈ ${perShare.toFixed(2)} per share`
              : 'Per-share margin unknown'
          }
        >
          <Input
            aria-label="Margin amount"
            inputMode="decimal"
            value={ticket.amount ?? ''}
            placeholder="optional"
            disabled={disabled}
            onChange={(e) => setAmount(e.target.value)}
            className="h-11 font-mono text-[15px] font-bold tabular-nums"
          />
        </Field>
      </div>

      {/* prices */}
      {(needsPrice || needsTrigger) && (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {needsPrice && (
            <Field label="Limit price">
              <Input
                aria-label="Limit price"
                inputMode="decimal"
                value={ticket.price}
                disabled={disabled}
                onChange={(e) => onChange({ ...ticket, price: e.target.value })}
                className="h-11 font-mono text-[15px] font-bold tabular-nums"
              />
            </Field>
          )}
          {needsTrigger && (
            <Field label="Trigger price">
              <Input
                aria-label="Trigger price"
                inputMode="decimal"
                value={ticket.triggerPrice}
                disabled={disabled}
                onChange={(e) => onChange({ ...ticket, triggerPrice: e.target.value })}
                className="h-11 font-mono text-[15px] font-bold tabular-nums"
              />
            </Field>
          )}
        </div>
      )}

      <Marketability
        side={ticket.side}
        orderType={ticket.orderType}
        price={Number(ticket.price)}
        ltp={quote?.ltp ?? null}
      />

      {selection.marginStatus === 'REQUIRES_ORDER_CONTEXT' && (
        <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
          The margin for this instrument depends on the order — the server figure appears once the
          ticket is complete.
        </p>
      )}
    </div>
  );
})

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {hint && <span className="text-[11px] tabular-nums text-muted-foreground/80">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
  disabled,
  tone,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  tone?: 'side';
}) {
  return (
    <div
      role="radiogroup"
      className={cn(
        'grid w-full overflow-hidden rounded-lg border border-border bg-muted/30',
        options.length === 2 && 'grid-cols-2',
        options.length === 3 && 'grid-cols-3',
        options.length === 4 && 'grid-cols-4',
        options.length >= 5 && 'grid-cols-5',
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'h-10 border-r border-border/60 text-[12px] font-bold uppercase tracking-wide transition-colors last:border-r-0 disabled:opacity-50',
              tone === 'side' && active
                ? opt.value === 'BUY'
                  ? 'bg-success text-success-foreground'
                  : 'bg-destructive text-destructive-foreground'
                : active
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Marketability({
  side,
  orderType,
  price,
  ltp,
}: {
  side: OrderSide;
  orderType: string;
  price: number;
  ltp: number | null;
}) {
  if (orderType !== 'L' && orderType !== 'SL') return null;
  if (ltp == null || !(price > 0)) return null;
  const marketable = side === 'BUY' ? ltp <= price : ltp >= price;
  return (
    <p
      className={cn(
        'rounded-lg border px-3 py-2 text-[12px] font-medium',
        marketable
          ? 'border-success/30 bg-success/[0.07] text-success'
          : 'border-warning/30 bg-warning/[0.07] text-warning',
      )}
    >
      {marketable
        ? `Marketable now — the live LTP ${ltp.toFixed(2)} already crosses your price.`
        : `Not marketable yet — the live LTP is ${ltp.toFixed(2)}; this order rests until it reaches your price.`}
    </p>
  );
}

function quantityFromMarginSafe(
  amount: number,
  perShare: number,
  lotSize: number,
): number | null {
  const raw = Math.floor(amount / perShare);
  if (raw < 1) return null;
  const aligned = Math.floor(raw / lotSize) * lotSize;
  return aligned >= lotSize ? aligned : null;
}
