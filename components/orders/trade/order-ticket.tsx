'use client';

import { Minus, Plus } from 'lucide-react';
import type { InstrumentSelection, LiveQuote, TicketState } from '@/components/orders/trade/types';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';
import { VALIDITIES } from '@/components/orders/trade/lifecycle';
import { cn } from '@/lib/utils';
import { sign } from '@/components/design-system';
import { marginPerShare, quantityFromMargin } from '@/lib/order-workspace';

/**
 * DENSITY CONTRACT (PWA)
 *
 * The whole ticket has to fit above the fold on a phone together with the
 * instrument header and the order bar, so:
 *   · every control is a 40px row (h-10) — large enough to hit with a thumb
 *   · side / type / product / validity are SEGMENTED controls, not <select>
 *     dropdowns: one tap instead of open-menu-then-tap, and the legal choices
 *     for the active terminal are visible at all times
 *   · all money / quantity values are `font-mono tabular-nums` so digits never
 *     shift horizontally while the 4 Hz LTP updates
 *   · nothing is rendered that the active terminal does not actually support —
 *     the option list comes from `caps`, the same static truth the backend
 *     publishes in BrokerCapabilities
 */
const labelCls = 'mb-1 block text-[9px] font-bold uppercase tracking-wider text-muted-foreground';
const inputCls =
  'h-10 w-full rounded-xl border border-border bg-background px-2.5 font-mono text-[15px] font-bold tabular-nums outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60';
const segWrapCls =
  'flex gap-1 rounded-xl border border-border/70 bg-muted/40 p-1';
const segIdleCls =
  'flex-1 rounded-lg text-[11px] font-bold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60';
const segOnCls = 'flex-1 rounded-lg bg-card text-[11px] font-extrabold uppercase tracking-wide shadow-sm ring-1 ring-border/70';

const fmt = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const fmtShort = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

export function OrderTicket({
  caps,
  ticket,
  onChange,
  quote,
  disabled,
  symbol,
  lotSize,
  selection,
}: {
  caps: TradeCapabilities;
  ticket: TicketState;
  onChange: (next: TicketState) => void;
  quote: LiveQuote | null;
  disabled?: boolean;
  symbol?: string;
  lotSize?: number;
  selection?: InstrumentSelection | null;
}) {
  const set = <K extends keyof TicketState>(key: K, value: TicketState[K]) => onChange({ ...ticket, [key]: value });

  const ltp = quote?.ltp != null ? Number(quote.ltp) : selection?.ltp != null && selection.ltp > 0 ? Number(selection.ltp) : null;
  const demo = caps.virtualCurrency;
  const unit = demo ? 'C' : '₹';
  const lot = Number.isFinite(Number(lotSize)) && Number(lotSize) >= 1 ? Math.round(Number(lotSize)) : 1;
  const minQty = lot;
  const setQty = (value: string) => onChange({ ...ticket, quantity: value, amount: '' });
  const decQty = () => setQty(String(Math.max(minQty, (parseInt(ticket.quantity, 10) || minQty) - lot)));
  const incQty = () => setQty(String((parseInt(ticket.quantity, 10) || 0) + lot));
  const needsPrice = ticket.orderType === 'L' || ticket.orderType === 'SL';
  const needsTrigger = ticket.orderType === 'SL' || ticket.orderType === 'SL-M';

  const qtyNum = parseInt(ticket.quantity, 10);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= 1;
  const refPrice = needsPrice ? Number(ticket.price) || null : ltp;
  const total = qtyValid && refPrice != null ? qtyNum * refPrice : null;

  const perShare = marginPerShare({
    price: refPrice,
    product: ticket.product,
    oneQtyMargin: selection?.oneQtyMargin,
  });
  const amountValue = ticket.amount ?? '';
  const onAmount = (value: string) => {
    const next: TicketState = { ...ticket, amount: value };
    const per = marginPerShare({ price: refPrice, product: ticket.product, oneQtyMargin: selection?.oneQtyMargin });
    const sized = quantityFromMargin({ marginAmount: Number(value), perShare: per, lotSize });
    if (sized != null) next.quantity = String(sized);
    onChange(next);
  };
  // One-line marketability read-out: a limit order only completes when the
  // live LTP reaches it. Showing this live is what keeps the pending order
  // from looking like a hang.
  const limitPrice = Number(ticket.price);
  const marketable =
    needsPrice && ltp != null && limitPrice > 0
      ? ticket.side === 'BUY'
        ? ltp <= limitPrice
        : ltp >= limitPrice
      : null;

  return (
    <div className="space-y-2">
      {/* ── ① Side — the single most important control on the page ── */}
      <div className="grid grid-cols-2 gap-1.5">
        {(['BUY', 'SELL'] as const).map((side) => (
          <button
            key={side}
            type="button"
            onClick={() => set('side', side)}
            disabled={disabled}
            aria-pressed={ticket.side === side}
            className={cn(
              'h-11 rounded-xl text-[15px] font-extrabold uppercase tracking-wide transition-all active:scale-[0.99]',
              ticket.side === side
                ? side === 'BUY'
                  ? 'bg-success text-success-foreground shadow-[0_2px_10px_-2px_hsl(var(--success)/0.5)]'
                  : 'bg-destructive text-destructive-foreground shadow-[0_2px_10px_-2px_hsl(var(--destructive)/0.5)]'
                : 'border border-border/60 bg-card text-muted-foreground hover:text-foreground',
            )}
          >
            {side}
          </button>
        ))}
      </div>

      {/* ── ② Order type — segmented, one tap ── */}
      <div>
        <label className={labelCls} htmlFor="order-type">Order type</label>
        <div className={segWrapCls} role="group" aria-labelledby="order-type">
          {caps.orderTypes.map((o) => (
            <button
              key={o}
              type="button"
              id={o === caps.orderTypes[0] ? 'order-type' : undefined}
              onClick={() => set('orderType', o)}
              disabled={disabled}
              aria-pressed={ticket.orderType === o}
              className={cn('h-8', ticket.orderType === o ? segOnCls : segIdleCls)}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      {/* ── ③ Product + validity — one row, two segmented groups ── */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls} htmlFor="order-product">Product</label>
          <div className={cn(segWrapCls, 'gap-0.5 p-0.5')} role="group" aria-labelledby="order-product">
            {caps.products.map((p) => (
              <button
                key={p}
                type="button"
                id={p === caps.products[0] ? 'order-product' : undefined}
                onClick={() => set('product', p)}
                disabled={disabled}
                aria-pressed={ticket.product === p}
                className={cn('h-8 text-[10px]', ticket.product === p ? segOnCls : segIdleCls)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="order-validity">Validity</label>
          <div className={cn(segWrapCls, 'gap-0.5 p-0.5')} role="group" aria-labelledby="order-validity">
            {VALIDITIES.map((v) => (
              <button
                key={v}
                type="button"
                id={v === VALIDITIES[0] ? 'order-validity' : undefined}
                onClick={() => set('validity', v)}
                disabled={disabled}
                aria-pressed={ticket.validity === v}
                className={cn('h-8 text-[10px]', ticket.validity === v ? segOnCls : segIdleCls)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── ④ Quantity stepper + margin amount ── */}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground" htmlFor="order-qty">
            Quantity {lot > 1 && <span className="font-medium normal-case tracking-normal">· 1 lot = {lot}</span>}
          </label>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {perShare != null ? `mgn/qty ${unit}${fmt(perShare)}` : 'mgn/qty —'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={decQty} disabled={disabled} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95" aria-label="Decrease quantity">
            <Minus className="h-4 w-4" />
          </button>
          <input
            id="order-qty"
            type="number"
            inputMode="numeric"
            min={minQty}
            step={lot}
            value={ticket.quantity}
            onChange={(e) => setQty(e.target.value)}
            disabled={disabled}
            aria-label="Quantity"
            className={cn(inputCls, 'min-w-0 flex-1 text-center')}
          />
          <button type="button" onClick={incQty} disabled={disabled} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95" aria-label="Increase quantity">
            <Plus className="h-4 w-4" />
          </button>
          {/* Amount drives quantity — margin sizing in the same row. The glyph
              follows the account currency, so Dummy never shows a rupee sign. */}
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[13px] font-bold text-muted-foreground" aria-hidden>
              {unit}
            </span>
            <input
              id="order-amount"
              type="number"
              inputMode="decimal"
              step="any"
              min="0"
              value={amountValue}
              onChange={(e) => onAmount(e.target.value)}
              disabled={disabled}
              placeholder={`Amt ${perShare != null ? fmtShort(perShare * lot) : '—'}`}
              aria-label="Margin amount to commit"
              className={cn(inputCls, 'pl-6 text-[13px]')}
            />
          </div>
        </div>
        {/* Turnover for the current size — the one number the amount box does
            not already imply. Margin/Avail/After live in the strip below. */}
        <p className="mt-1 truncate text-[10px] text-muted-foreground">
          {perShare == null
            ? 'Margin sizing needs a live price.'
            : `${qtyValid ? `${qtyNum} qty` : 'qty'} × ${unit}${fmtShort(refPrice ?? 0)} = ${unit}${fmtShort(total ?? 0)} · mgn/qty ${unit}${fmtShort(perShare)}`}
        </p>
      </div>

      {/* ── ⑤ Price fields — only the ones the chosen type needs ── */}
      {(needsPrice || needsTrigger) && (
        <div className="grid grid-cols-2 gap-1.5">
          {needsPrice && (
            <div>
              <div className={cn(labelCls, 'flex items-center justify-between gap-1')}>
                <span>Limit ({unit})</span>
                {ltp != null && (
                  <button type="button" onClick={() => set('price', ltp.toFixed(2))} disabled={disabled} className="rounded border border-primary/30 bg-primary/10 px-1 py-px text-[9px] font-bold text-primary transition-colors hover:bg-primary/20">
                    = LTP
                  </button>
                )}
              </div>
              <input
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0"
                value={ticket.price === '0' ? '' : ticket.price}
                onChange={(e) => set('price', e.target.value)}
                disabled={disabled}
                className={inputCls}
                placeholder={`${unit}0.00`}
                aria-label="Limit price"
              />
            </div>
          )}
          {needsTrigger && (
            <div>
              <label className={labelCls} htmlFor="order-trigger">Trigger ({unit})</label>
              <input
                id="order-trigger"
                type="number"
                inputMode="decimal"
                step="0.05"
                min="0"
                value={ticket.triggerPrice}
                onChange={(e) => set('triggerPrice', e.target.value)}
                disabled={disabled}
                className={inputCls}
                placeholder="Trigger"
                aria-label="Trigger price"
              />
            </div>
          )}
        </div>
      )}

      {/* ── ⑥ Fill state — the "will it complete now?" line ── */}
      {needsPrice && ltp != null && limitPrice > 0 && (
        <div className={cn(
          'flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-[11px] font-semibold',
          marketable
            ? 'border-success/40 bg-success/10 text-success'
            : 'border-warning/40 bg-warning/10 text-warning',
        )}>
          <span className="truncate">
            {marketable
              ? `${ticket.side} ${symbol ?? 'order'} will fill — LTP ${fmt(ltp)} reached your limit.`
              : `PENDING — LTP ${fmt(ltp)} has not reached ${unit}${fmt(limitPrice)} yet.`}
          </span>
          <span className="shrink-0 font-mono tabular-nums">{sign((ltp - limitPrice) as number)}{(Math.abs(ltp - limitPrice)).toFixed(2)}</span>
        </div>
      )}

      {ticket.product === 'CASH' && (
        <p className="rounded-xl border border-info/25 bg-info/5 px-2.5 py-1.5 text-[10px] text-muted-foreground">
          Cash delivery — full payment, settles into <span className="font-semibold text-foreground">Holdings</span>.
        </p>
      )}
    </div>
  );
}