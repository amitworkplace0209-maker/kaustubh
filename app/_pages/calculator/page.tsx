'use client';

// ---- Trading Charges Calculator (Phase 17-19) ----
//
// Pre-trade charge preview powered by THE canonical charge engine
// (lib/charge-engine.ts). Market orders use live LTP; limit orders use the
// entered price. Every input change recalculates instantly - no API call is
// needed for the math itself, only for quotes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRightLeft, BadgeIndianRupee, BarChart3, Calculator as CalcIcon,
  Coins, IndianRupee, Layers, Receipt, Search, SlidersHorizontal,
  TrendingDown, TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import StockSearch from '@/components/orders/stock-search';
import type { StockResult } from '@/components/orders/stock-search';
import { ChargeDetails } from '@/components/charges/charge-details';
import { calculateCharges, CALCULATION_VERSION, type Side } from '@/lib/charge-engine';
import { getQuote } from '@/lib/api';
import { subscribeTicks } from '@/lib/shared-sse';
import { useAccountMode } from '@/lib/settings-store';
import { fmtRs } from '@/lib/formatters';
import { cn } from '@/lib/utils';

type QuoteState = {
  ltp: number;
  change: number;
  changePct: number;
  status: 'LIVE' | 'STALE' | 'DISCONNECTED' | '';
};

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '') { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  return 0;
}

function extractFirstQuote(data: any): any {
  const d = data?.data;
  if (Array.isArray(d)) return d[0] || {};
  if (d && typeof d === 'object') return d;
  return {};
}

/** Section shell matching the dashboard card language (bar + tint + icon). */
function CalcSection({
  title, icon: Icon, bar, chip, children, className,
}: {
  title: string;
  icon: React.ElementType;
  /** Top accent bar classes, e.g. 'bg-warning'. */
  bar: string;
  /** Icon chip classes (background/text/ring). */
  chip: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('relative overflow-hidden rounded-xl border border-border/60 shadow-soft', className)}>
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2px]', bar)} />
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg ring-1 ring-inset', chip)}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      </div>
      <div className="px-4 pb-4 pt-2.5">{children}</div>
    </section>
  );
}

function Row({ label, value, strong, accent, hint }: {
  label: string; value: string; strong?: boolean; accent?: string; hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-[3px]">
      <span className="text-xs text-muted-foreground">
        {label}
        {hint && <span className="ml-1 text-[10px] opacity-70">({hint})</span>}
      </span>
      <span className={cn('text-right font-mono tabular-nums', strong ? 'text-sm font-semibold' : 'text-xs', accent ?? '')}>
        {value}
      </span>
    </div>
  );
}

export default function CalculatorPage() {
  const accountMode = useAccountMode();
  const [stock, setStock] = useState<StockResult | null>(null);
  const [side, setSide] = useState<Side>('BUY');
  const [product, setProduct] = useState<'MIS' | 'CNC'>('MIS');
  const [orderType, setOrderType] = useState<'MKT' | 'L'>('MKT');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [quote, setQuote] = useState<QuoteState>({ ltp: 0, change: 0, changePct: 0, status: '' });
  const [quoteLoading, setQuoteLoading] = useState(false);

  // ---- quote loading (REST snapshot + shared SSE stream, one connection) ----

  const loadQuote = useCallback(async (s: StockResult) => {
    setQuoteLoading(true);
    try {
      const data = await getQuote([{ instrument_token: s.token, exchange_segment: s.exchange }], 'ltp');
      const raw = extractFirstQuote(data);
      const ltp = num(raw.ltp || raw.last_price);
      const prevClose = num(raw.ohlc?.close || raw.close || raw.previous_close);
      setQuote({
        ltp,
        change: ltp > 0 && prevClose > 0 ? ltp - prevClose : 0,
        changePct: ltp > 0 && prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0,
        status: ltp > 0 ? 'LIVE' : 'STALE',
      });
    } catch {
      setQuote((q) => ({ ...q, status: q.ltp > 0 ? 'STALE' : 'DISCONNECTED' }));
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!stock) return;
    loadQuote(stock);
  }, [stock, loadQuote]);

  useEffect(() => {
    if (!stock) return;
    // One SSE session for the whole app (shared reconnect/coalescing); this
    // screen re-subscribes only when the selected instrument changes.
    const stockRef = { current: stock };
    stockRef.current = stock;
    return subscribeTicks((raw) => {
      const t = raw;
      try {
        if (t.ltp == null || Number(t.ltp) <= 0) return;
        const s = stockRef.current;
        const tokMatch = String(t.instrumentToken ?? '') === String(s.token);
        const tsymMatch = s.tradingSymbol &&
          String(t.tradingSymbol ?? '').toUpperCase() === s.tradingSymbol.toUpperCase();
        const symMatch = s.symbol &&
          String(t.symbol ?? '').toUpperCase() === s.symbol.toUpperCase();
        if (!tokMatch && !tsymMatch && !symMatch) return;
        setQuote((q) => ({ ...q, ltp: num(t.ltp), status: 'LIVE' }));
      } catch { /* ignore malformed frame */ }
    });
  }, [stock]);

  // Market orders execute at LTP; limit orders use the entered price.
  const effectivePrice = useMemo(() => {
    if (orderType === 'L') {
      const p = parseFloat(price);
      return Number.isFinite(p) && p > 0 ? p : 0;
    }
    return quote.ltp;
  }, [orderType, price, quote.ltp]);

  const qtyNum = useMemo(() => {
    const q = parseInt(quantity, 10);
    return Number.isFinite(q) && q > 0 ? q : 0;
  }, [quantity]);

  const charges = useMemo(() => calculateCharges({
    side,
    quantity: qtyNum,
    price: effectivePrice,
    product,
    exchange: stock?.exchangeSegment || stock?.exchange,
    timestamp: new Date(),
  }), [side, qtyNum, effectivePrice, product, stock]);

  // BUY -> cash required (value + charges); SELL -> net proceeds (value - charges).
  const netAmount = side === 'BUY'
    ? charges.turnover + charges.totalCharges
    : charges.turnover - charges.totalCharges;

  const dirUp = quote.change > 0;
  const dirDown = quote.change < 0;
  const ltpClr = dirUp ? 'text-success' : dirDown ? 'text-destructive' : 'text-foreground';

  const onSelect = useCallback((s: StockResult) => {
    setStock(s);
    setPrice('');
  }, []);

  const inputValid = qtyNum > 0 && effectivePrice > 0;

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Charges Calculator</h1>
            <span
              title={accountMode === 'api' ? 'Real broker account (Kotak Neo)' : 'Virtual demo account'}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11px] font-semibold tracking-wide',
                accountMode === 'api'
                  ? 'border-success/30 bg-success/[0.07] text-success'
                  : 'border-purple/40 bg-purple/[0.07] text-purple',
              )}
            >
              <span aria-hidden className={cn(
                'h-1.5 w-1.5 rounded-full animate-pulse',
                accountMode === 'api'
                  ? 'bg-success [box-shadow:0_0_5px_hsl(var(--success)/0.7)]'
                  : 'bg-purple [box-shadow:0_0_5px_hsl(var(--purple)/0.6)]',
              )} />
              {accountMode === 'api' ? 'API MODE' : 'DEMO MODE'}
            </span>
          </div>
          <p className="mt-1 text-sm font-normal text-muted-foreground">
            Know your exact charges before you place the order &mdash; same engine that powers every page.
          </p>
        </div>
        <Link href="/orders" className="text-xs font-medium text-primary hover:text-primary/80">
          Go to Order Form <ArrowRightLeft className="inline h-3 w-3" />
        </Link>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {/* ---------------- LEFT: inputs ---------------- */}
        <div className="space-y-4">
          {/* TRADE INPUT */}
          <CalcSection title="Trade Input" icon={Search} bar="bg-info" chip="bg-info/10 text-info ring-info/25">
            {!stock ? (
              <>
                <StockSearch onSelect={(s) => onSelect(s)} />
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Search a stock to load its live price and configure the trade.
                </p>
              </>
            ) : (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3 rounded-lg bg-muted/40 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{stock.tradingSymbol || stock.symbol}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {stock.companyName || '\u00A0'}
                    </p>
                    <p className="mt-1 text-[10px] font-mono text-muted-foreground">
                      {[stock.exchangeSegment || stock.exchange].join(' \u00B7 ')} Â· token {stock.token}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setStock(null)}>
                    Change
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {/* Side */}
                  <div>
                    <Label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <ArrowRightLeft className="h-3 w-3" /> Side
                    </Label>
                    <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border/50 bg-background p-1">
                      {(['BUY', 'SELL'] as const).map((s) => (
                        <button
                          key={s}
                          onClick={() => setSide(s)}
                          className={cn(
                            'h-9 rounded-md text-sm font-semibold transition-all',
                            side === s
                              ? s === 'BUY'
                                ? 'bg-success text-success-foreground shadow-md shadow-success/25 ring-1 ring-success/40'
                                : 'bg-destructive text-destructive-foreground shadow-md shadow-destructive/25 ring-1 ring-destructive/40'
                              : 'text-muted-foreground hover:bg-muted/60',
                          )}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Product */}
                  <div>
                    <Label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Layers className="h-3 w-3" /> Product
                    </Label>
                    <Select value={product} onValueChange={(v) => setProduct(v === 'CNC' ? 'CNC' : 'MIS')}>
                      <SelectTrigger className="h-11 rounded-lg border-border/60 text-sm font-medium">
                        <SelectValue placeholder="Select product" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MIS"><span className="font-medium">MIS</span><span className="text-muted-foreground"> Â· Intraday</span></SelectItem>
                        <SelectItem value="CNC"><span className="font-medium">CNC</span><span className="text-muted-foreground"> Â· Delivery</span></SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </CalcSection>

          {/* PRICE & QUANTITY */}
          <CalcSection title="Price & Quantity" icon={SlidersHorizontal} bar="bg-info dark:bg-info" chip="bg-info/10 text-info ring-info/25">
            {!stock ? (
              <p className="py-2 text-xs text-muted-foreground">Select a stock first.</p>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <BarChart3 className="h-3 w-3" /> Order Type
                    </Label>
                    <Select value={orderType} onValueChange={(v) => setOrderType(v === 'MKT' ? 'MKT' : 'L')}>
                      <SelectTrigger className="h-11 rounded-lg border-border/60 text-sm font-medium">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MKT"><span className="font-medium">MARKET</span><span className="text-muted-foreground"> Â· at live LTP</span></SelectItem>
                        <SelectItem value="L"><span className="font-medium">LIMIT</span><span className="text-muted-foreground"> Â· at your price</span></SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="calc-qty" className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Coins className="h-3 w-3" /> Quantity
                    </Label>
                    <Input
                      id="calc-qty"
                      type="number" min="1" step="1"
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="h-11 rounded-lg border-border/60 text-center font-mono text-base font-semibold tabular-nums"
                    />
                  </div>
                </div>

                {orderType === 'L' ? (
                  <div>
                    <Label htmlFor="calc-price" className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <IndianRupee className="h-3 w-3" /> Limit Price
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        id="calc-price"
                        type="number" inputMode="decimal" step="0.05" min="0"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        placeholder="0.00"
                        className="h-11 rounded-lg border-border/60 font-mono text-base tabular-nums"
                      />
                      {quote.ltp > 0 && (
                        <Button variant="outline" size="sm" className="h-11 shrink-0 rounded-lg text-xs"
                          onClick={() => setPrice(quote.ltp.toFixed(2))}>
                          Use LTP {fmtRs(quote.ltp)}
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="rounded-lg border border-border/40 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
                    MARKET order &mdash; charges use the live LTP
                    {quote.ltp > 0 ? <> of <span className="font-mono font-semibold text-foreground">{fmtRs(quote.ltp)}</span></> : ' once available'}.
                  </p>
                )}

                {/* Live quote tile */}
                <div className={cn(
                  'flex items-center justify-between rounded-lg border p-3 transition-colors',
                  dirUp ? 'border-success/30 bg-success/[0.05]'
                    : dirDown ? 'border-destructive/30 bg-destructive/[0.05]'
                      : 'border-border/40 bg-muted/20',
                )}>
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">LTP</p>
                    <p className={cn('font-mono text-xl font-semibold tabular-nums leading-tight', ltpClr)}>
                      {quote.ltp > 0 ? fmtRs(quote.ltp) : '\u2014'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={cn('font-mono text-xs font-semibold tabular-nums', ltpClr)}>
                      {quote.ltp > 0
                        ? `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)} (${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2)}%)`
                        : '\u2014'}
                    </p>
                    <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                      <span className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        quote.status === 'LIVE' ? 'bg-success animate-pulse'
                          : quote.status === 'STALE' ? 'bg-warning' : 'bg-destructive',
                      )} />
                      {quote.status === 'LIVE' ? 'LIVE' : quote.status === 'STALE' ? 'STALE' : 'NO FEED'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CalcSection>
        </div>

        {/* ---------------- RIGHT: results ---------------- */}
        <div className="space-y-4">
          <CalcSection title="Brokerage" icon={BadgeIndianRupee} bar="bg-purple" chip="bg-purple/10 text-purple ring-purple/25">
            {inputValid ? (
              <>
                <Row label="Plan" value={product === 'MIS' ? 'Standard Equity Intraday' : 'Standard Equity Delivery'} accent="text-foreground" />
                <Row label="Pricing" value="0.03% of turnover per executed order" accent="text-foreground" />
                <Row label="Brokerage" value={fmtRs(charges.brokerage)} strong />
              </>
            ) : (
              <p className="py-2 text-xs text-muted-foreground">Enter quantity and a valid price to see brokerage.</p>
            )}
          </CalcSection>

          <CalcSection title="Statutory Charges" icon={Receipt} bar="bg-warning" chip="bg-warning/15 text-warning ring-warning/30">
            {inputValid ? (
              <>
                <Row label="STT" value={fmtRs(charges.stt)} hint={side === 'BUY' ? (product === 'MIS' ? 'not levied intraday BUY' : '0.1% buy') : product === 'MIS' ? '0.025% sell' : '0.1% sell'} />
                <Row label="Exchange Txn Charges" value={fmtRs(charges.exchangeTransactionCharges)} hint={(stock?.exchangeSegment || stock?.exchange || '').toUpperCase().startsWith('BSE') ? 'BSE' : 'NSE'} />
                <Row label="SEBI Turnover Fee" value={fmtRs(charges.sebiCharges)} />
                <Row label="Stamp Duty" value={fmtRs(charges.stampDuty)} hint={side === 'BUY' ? 'buy side only' : 'not levied on sell'} />
                <Row label="GST" value={fmtRs(charges.gst)} hint="18% on taxable services" />
                <Row label="Other Charges" value={fmtRs(charges.otherCharges)} />
                <div className="my-1.5 border-t border-border/50" />
                <Row label="GST Taxable Base" value={fmtRs(charges.gstTaxableBase)} hint="brokerage + txn + SEBI" />
              </>
            ) : (
              <p className="py-2 text-xs text-muted-foreground">Enter quantity and a valid price to see statutory charges.</p>
            )}
          </CalcSection>

          <CalcSection title="Total" icon={Coins} bar="bg-teal" chip="bg-teal/10 text-teal ring-teal/25">
            {inputValid ? (
              <>
                <Row label="Gross Order Value" value={fmtRs(charges.turnover)} />
                <Row label="Estimated Total Charges" value={fmtRs(charges.totalCharges)} strong accent="text-warning" />
              </>
            ) : (
              <p className="py-2 text-xs text-muted-foreground">Waiting for valid inputs.</p>
            )}
          </CalcSection>

          {/* NET RESULT â€” the headline outcome */}
          <section
            data-state={inputValid ? (netAmount > charges.turnover ? 'cost' : 'proceeds') : 'idle'}
            className={cn(
              'relative overflow-hidden rounded-xl border shadow-soft transition-colors duration-200',
              !inputValid ? 'border-border/60'
                : side === 'BUY' ? 'border-success/30' : 'border-info/30',
            )}
          >
            <span aria-hidden className={cn(
              'absolute inset-x-0 top-0 h-[2px]',
              !inputValid ? 'bg-border' : side === 'BUY' ? 'bg-success' : 'bg-info',
            )} />
            <div className="px-4 pb-4 pt-3">
              <div className="flex items-center gap-2">
                <span className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset',
                  side === 'BUY'
                    ? 'bg-success/15 text-success ring-success/30'
                    : 'bg-info/10 text-info ring-info/25',
                )}>
                  {side === 'BUY' ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                </span>
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Net Result
                </h2>
              </div>

              {inputValid ? (
                <div className="mt-3 space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-muted-foreground">
                      {side === 'BUY' ? 'Total Cash Required' : 'Net Sell Proceeds'}
                    </span>
                    <span className={cn(
                      'font-mono text-2xl font-semibold tabular-nums tracking-tight',
                      side === 'BUY' ? 'text-success' : 'text-info',
                    )}>
                      {fmtRs(netAmount)}
                    </span>
                  </div>
                  <p className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {side === 'BUY'
                      ? `${fmtRs(charges.turnover)} order + ${fmtRs(charges.totalCharges)} charges`
                      : `${fmtRs(charges.turnover)} order \u2212 ${fmtRs(charges.totalCharges)} charges`}
                  </p>
                </div>
              ) : (
                <p className="mt-3 py-1 text-xs text-muted-foreground">
                  Configure a trade on the left to preview the net cash impact.
                </p>
              )}

              {/* Full expandable breakdown reuses THE shared component */}
              <ChargeDetails
                className="mt-3"
                values={{
                  brokerage: charges.brokerage,
                  stt: charges.stt,
                  exchangeTransactionCharges: charges.exchangeTransactionCharges,
                  sebiCharges: charges.sebiCharges,
                  stampDuty: charges.stampDuty,
                  gst: charges.gst,
                  otherCharges: charges.otherCharges,
                  totalCharges: charges.totalCharges,
                }}
                turnover={inputValid ? charges.turnover : null}
                gstTaxableBase={inputValid ? charges.gstTaxableBase : null}
                calculationVersion={CALCULATION_VERSION}
                calculatedAt={new Date().toISOString()}
                confirmed={false}
                compact
              />
            </div>
          </section>

          <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
            <CalcIcon className="mt-0.5 h-3 w-3 shrink-0" />
            Estimates use the app&apos;s configured rate tables (engine v{CALCULATION_VERSION}) and are
            indicative until the broker confirms final contract-note charges.
          </p>
        </div>
      </div>
    </div>
  );
}
