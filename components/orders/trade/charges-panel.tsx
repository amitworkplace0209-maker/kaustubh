'use client';

import { useEffect, useState } from 'react';
import { Loader2, ReceiptText } from 'lucide-react';
import { SectionCard } from '@/components/design-system';
import { getDummyPreview } from '@/lib/api';
import { chargesTotal } from '@/lib/order-workspace';
import { fmtMoney, type TradeCapabilities } from '@/components/orders/trade/capabilities';
import type { InstrumentSelection, TicketState } from '@/components/orders/trade/types';

export type ChargesPreview = {
  charges: Record<string, any> | null;
  total: number | null;
  marginRequired: number | null;
  freeMargin: number | null;
  after: number | null;
  sufficient: boolean | null;
};

/** Real charges + margin, owned by backend services.
 *
 *  Dummy terminal → POST /api/dummy/preview (paper engine charge model).
 *  Kotak/Shoonya → no backend charges API exists, so the panel says so
 *  honestly instead of inventing broker rates. Kotak margin still comes
 *  from the broker margin API via the risk gate panel. */
export function ChargesPanel({
  caps,
  selection,
  ticket,
  price,
  onPreview,
}: {
  caps: TradeCapabilities;
  selection: InstrumentSelection | null;
  ticket: TicketState;
  /** Effective per-unit price (LTP for MKT, limit otherwise). Null = unknown. */
  price: number | null;
  onPreview?: (preview: ChargesPreview | null) => void;
}) {
  const [preview, setPreview] = useState<ChargesPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const qty = Number(ticket.quantity);
  const ready =
    selection != null &&
    Number.isInteger(qty) &&
    qty >= 1 &&
    price != null &&
    price > 0;

  useEffect(() => {
    onPreview?.(preview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  useEffect(() => {
    if (!ready || !selection || price == null) {
      setPreview(null);
      setError('');
      setChecking(false);
      return;
    }
    // No server charges model for live terminals — stay honest.
    if (caps.terminal !== 'dummy') {
      setPreview(null);
      setError('');
      setChecking(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setChecking(true);
      setError('');
      try {
        const res = await getDummyPreview({
          symbol: selection.symbol,
          tradingSymbol: selection.tradingSymbol || selection.symbol,
          exchange: selection.exchange,
          exchangeSegment: selection.exchange.toUpperCase(),
          token: selection.token,
          transactionType: ticket.side,
          product: ticket.product,
          orderType: ticket.orderType,
          quantity: qty,
          price: ticket.orderType === 'MKT' ? 0 : price,
          triggerPrice: Number(ticket.triggerPrice) || 0,
          ltp: price,
        });
        if (cancelled) return;
        if (res?.ok) {
          setPreview({
            charges: res.charges ?? null,
            total: chargesTotal(res.charges),
            marginRequired: typeof res.marginRequired === 'number' ? res.marginRequired : null,
            freeMargin: typeof res.freeMargin === 'number' ? res.freeMargin : null,
            after: typeof res.remainingAfterBuy === 'number' ? res.remainingAfterBuy : null,
            sufficient: typeof res.sufficient === 'boolean' ? res.sufficient : null,
          });
        } else {
          setPreview(null);
          setError('Preview unavailable from the Dummy engine.');
        }
      } catch (err: any) {
        if (cancelled) return;
        setPreview(null);
        setError(err?.message ?? 'Preview request failed.');
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ready,
    selection?.symbol,
    selection?.token,
    ticket.side,
    ticket.product,
    ticket.orderType,
    ticket.quantity,
    ticket.triggerPrice,
    price,
    caps.terminal,
  ]);

  const currency = caps.virtualCurrency ? 'Coin' : caps.accountCurrency;
  const rows: Array<[string, number | null]> = preview?.charges
    ? [
        ['Brokerage', num(preview.charges.brokerage)],
        ['STT', num(preview.charges.stt)],
        ['Exchange txn', num(preview.charges.exchangeTransactionCharges ?? preview.charges.exchangeTxn)],
        ['GST', num(preview.charges.gst)],
        ['SEBI', num(preview.charges.sebiCharges ?? preview.charges.sebi)],
        ['Stamp duty', num(preview.charges.stampDuty)],
      ]
    : [];

  return (
    <SectionCard title="Charges & margin" icon={ReceiptText}>
      {checking && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching server preview…
        </p>
      )}
      {!checking && error && <p className="text-[11px] text-destructive">{error}</p>}
      {!checking && !error && preview && (
        <div className="space-y-1">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-semibold tabular-nums">
                {value != null ? fmtMoney(value, currency) : '—'}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t border-border/60 pt-1.5 text-xs">
            <span className="font-semibold">Total charges</span>
            <span className="font-bold tabular-nums">
              {preview.total != null ? fmtMoney(preview.total, currency) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Required margin</span>
            <span className="font-semibold tabular-nums">
              {preview.marginRequired != null ? fmtMoney(preview.marginRequired, currency) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Available margin</span>
            <span className="font-semibold tabular-nums">
              {preview.freeMargin != null ? fmtMoney(preview.freeMargin, currency) : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Margin after order</span>
            <span className="font-semibold tabular-nums">
              {preview.after != null ? fmtMoney(preview.after, currency) : '—'}
            </span>
          </div>
          {preview.sufficient === false && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] font-semibold text-destructive">
              Insufficient margin — the backend will reject this order.
            </p>
          )}
          <p className="text-[10px] text-muted-foreground/70">
            Server-computed by the Dummy paper engine (estimate until filled).
          </p>
        </div>
      )}
      {!checking && !error && !preview && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {caps.terminal === 'dummy'
            ? ready
              ? 'Preview pending…'
              : 'Enter a quantity to receive the server charges preview.'
            : 'Charges calculation unavailable — this terminal exposes no charges API, so no estimate is shown instead of a fabricated one.'}
        </p>
      )}
    </SectionCard>
  );
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
