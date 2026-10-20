'use client';

import { useEffect, useState } from 'react';
import { Receipt, Loader2, Shield, Zap, Calculator } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TradeCapabilities } from '@/components/orders/trade/capabilities';
import type { InstrumentSelection, TicketState } from '@/components/orders/trade/types';

interface ChargesPanelProps {
  caps: TradeCapabilities;
  selection: InstrumentSelection | null;
  ticket: TicketState;
  price: number | null;
  onPreview: (preview: { charges: Record<string, any> | null; total: number | null; marginRequired: number | null; freeMargin: number | null; after: number | null; sufficient: boolean | null } | null) => void;
}

const CHARGE_RATES = {
  brokerage: 0.0003, brokerage_flat: 10, stt_buy: 0.001, stt_sell: 0.00025,
  exchange_txn: 0.0000345, gst: 0.18, sebi: 0.00001, stamp_duty: 0.000015,
};

const DUMMY_FLAT_BROKERAGE = process.env.NEXT_PUBLIC_DUMMY_BROKERAGE_MODE === 'flat10';

function calculateCharges(side: string, price: number, quantity: number, product: string) {
  const value = price * quantity;
  const isDelivery = ['CNC', 'CASH', 'CO', 'MARGIN'].includes(product.toUpperCase());
  const brokerage = DUMMY_FLAT_BROKERAGE ? CHARGE_RATES.brokerage_flat : value * CHARGE_RATES.brokerage;
  const stt = isDelivery ? value * 0.001 : side === 'BUY' ? 0 : value * CHARGE_RATES.stt_sell;
  const stampRate = side !== 'BUY' ? 0 : isDelivery ? 0.00015 : 0.00003;
  const exchange_txn = value * CHARGE_RATES.exchange_txn;
  const sebi = value * CHARGE_RATES.sebi;
  const gst = (brokerage + exchange_txn + sebi) * CHARGE_RATES.gst;
  const stamp_duty = value * stampRate;
  const total = brokerage + stt + exchange_txn + gst + sebi + stamp_duty;
  return { brokerage: +brokerage.toFixed(2), stt: +stt.toFixed(2), exchangeTxn: +exchange_txn.toFixed(2), gst: +gst.toFixed(2), sebi: +sebi.toFixed(2), stampDuty: +stamp_duty.toFixed(2), total: +total.toFixed(2) };
}

export function ChargesPanel({ caps, selection, ticket, price, onPreview }: ChargesPanelProps) {
  const [preview, setPreview] = useState<{ charges: Record<string, any> | null; total: number | null; marginRequired: number | null; freeMargin: number | null; after: number | null; sufficient: boolean | null } | null>(null);
  const [loading, setLoading] = useState(false);

  const qty = parseInt(ticket.quantity, 10);
  const needsPrice = ticket.orderType === 'L' || ticket.orderType === 'SL';
  const refPrice = needsPrice ? parseFloat(ticket.price) : price;
  const canCalc = selection && qty >= 1 && refPrice != null && refPrice > 0;

  useEffect(() => {
    if (!canCalc) { setPreview(null); onPreview(null); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        if (caps.virtualCurrency) {
          const charges = calculateCharges(ticket.side, refPrice!, qty, ticket.product);
          const value = refPrice! * qty;
          const marginFactor = { MIS: 0.2, INTRADAY: 0.2, CNC: 1, CASH: 1, CO: 0.2, BO: 0.2 }[ticket.product.toUpperCase()] || 0.2;
          const marginRequired = value * marginFactor;
          const res = { charges, total: charges.total, marginRequired, freeMargin: 0, after: -marginRequired, sufficient: false };
          if (!cancelled) { setPreview(res); onPreview(res); }
        } else {
          // Real broker - would call margin API
          const res = { charges: null, total: null, marginRequired: null, freeMargin: null, after: null, sufficient: null };
          if (!cancelled) { setPreview(res); onPreview(res); }
        }
      } catch {
        if (!cancelled) { setPreview(null); onPreview(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [canCalc, caps.virtualCurrency, ticket.side, ticket.product, ticket.orderType, qty, refPrice, price, selection]);

  if (!selection) return <p className="text-[11px] text-muted-foreground text-center py-4">Select a stock to see charges</p>;

  return (
    <div className="space-y-2">
      {loading && <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Calculating charges…</div>}

      {preview?.charges && (
        <div className="rounded-xl border border-border/60 bg-card p-2.5">
          <div className="flex items-center gap-1.5 mb-2"><Receipt className="h-4 w-4 text-primary" /><span className="text-[12px] font-extrabold tracking-tight">Charges Breakdown</span></div>
          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            {[
              ['Brokerage', preview.charges.brokerage],
              ['STT', preview.charges.stt],
              ['Exchange', preview.charges.exchangeTxn],
              ['GST', preview.charges.gst],
              ['SEBI', preview.charges.sebi],
              ['Stamp Duty', preview.charges.stampDuty],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k}</span><span className="font-mono font-bold tabular-nums">₹{v.toFixed(2)}</span></div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-border/50 flex justify-between">
            <span className="font-bold text-[11px]">Total</span>
            <span className="font-mono text-[12px] font-bold tabular-nums text-primary">₹{preview.total!.toFixed(2)}</span>
          </div>
        </div>
      )}

      {preview?.marginRequired != null && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 p-2.5">
          <div className="flex items-center gap-1.5 mb-2"><Shield className="h-4 w-4 text-warning" /><span className="text-[12px] font-extrabold tracking-tight text-warning">Margin Required</span></div>
          <div className="grid grid-cols-2 gap-1.5 text-[10px]">
            <div className="flex justify-between"><span className="text-muted-foreground">Required</span><span className="font-mono font-bold tabular-nums text-warning">₹{preview.marginRequired!.toLocaleString('en-IN')}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Free After</span><span className={cn('font-mono font-bold tabular-nums', preview.sufficient ? 'text-success' : 'text-destructive')}>{preview.after != null ? `₹${preview.after.toLocaleString('en-IN')}` : '—'}</span></div>
          </div>
        </div>
      )}

      {!canCalc && !loading && (
        <p className="text-[10px] text-muted-foreground text-center py-2">Enter quantity and price to calculate charges</p>
      )}
    </div>
  );
}