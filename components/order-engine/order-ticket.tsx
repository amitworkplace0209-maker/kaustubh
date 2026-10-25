'use client';

/**
 * Order Engine order ticket.
 *
 * The ticket shows the live LTP it is about to trade against and states plainly
 * what will happen to the order, because acceptance and execution are different
 * facts:
 *
 *   MARKET  — needs a live price; executes on the next real tick.
 *   LIMIT   — rests with the broker until the LTP crosses the limit.
 *   STOP    — rests until the LTP crosses the trigger.
 *
 * The LTP sent with the order is only ever the price this ticket is already
 * displaying (from the real tick stream). When none exists the field is sent as
 * 0 and the backend parks the order as PENDING rather than inventing a fill.
 */
import { useMemo, useState } from 'react';
import { Loader2, Search, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import type { CanonicalInstrument } from '@/lib/instrument-search';
import { TONE_CLASS, fmtNum } from './status';
import type { OrderEngineLive } from './use-order-engine-live';

const ORDER_TYPES = [
  { value: 'MKT', label: 'Market', needsPrice: false, needsTrigger: false },
  { value: 'L', label: 'Limit', needsPrice: true, needsTrigger: false },
  { value: 'SL', label: 'Stop Loss', needsPrice: false, needsTrigger: true },
  { value: 'SL-M', label: 'Stop Loss Market', needsPrice: false, needsTrigger: true },
];

const PRODUCTS = ['MIS', 'CNC'];

export function OrderEngineTicket({
  engine,
  busy,
  onSubmit,
}: {
  engine: OrderEngineLive;
  busy: boolean;
  onSubmit: (intent: Parameters<OrderEngineLive['place']>[0]) => Promise<{ ok: boolean }>;
}) {
  const [query, setQuery] = useState('');
  const [instrument, setInstrument] = useState<CanonicalInstrument | null>(null);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState('MKT');
  const [product, setProduct] = useState('MIS');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [trigger, setTrigger] = useState('');

  const search = useInstrumentSearch(query, { limit: 6 });
  const typeSpec = ORDER_TYPES.find((t) => t.value === orderType) ?? ORDER_TYPES[0];
  const ltp = instrument?.ltp ?? null;
  const paper = Boolean(engine.state?.isPaper);
  const hasPrice = ltp != null && ltp > 0;

  const intentPreview = useMemo(() => {
    const qty = Number(quantity) || 0;
    const px = Number(price) || 0;
    const trg = Number(trigger) || 0;
    if (!instrument || qty <= 0) return null;
    if (orderType === 'MKT') {
      return hasPrice
        ? `Market order — will execute against the live price (~${fmtNum(ltp)}) as soon as it reaches the broker.`
        : 'Market order — no live price available. It will be accepted as pending and execute when a real market price arrives.';
    }
    if (orderType === 'L') {
      const willRest = hasPrice
        ? side === 'BUY'
          ? (ltp as number) > px
          : (ltp as number) < px
        : true;
      return willRest
        ? `Limit ${side} ${qty} @ ${fmtNum(px)} — rests with the broker until the LTP reaches it.`
        : `Limit ${side} ${qty} @ ${fmtNum(px)} — marketable against the live price, so it should execute promptly.`;
    }
    const willRest = hasPrice
      ? side === 'BUY'
        ? (ltp as number) < trg
        : (ltp as number) > trg
      : true;
    return willRest
      ? `Stop ${side} ${qty} — waiting for the LTP to cross ${fmtNum(trg)}.`
      : `Stop ${side} ${qty} — trigger ${fmtNum(trg)} is already crossed, so it should execute promptly.`;
  }, [instrument, quantity, orderType, side, price, trigger, ltp, hasPrice]);

  const submit = async () => {
    if (!instrument) return;
    const qty = Number(quantity);
    if (!qty || qty <= 0) return;
    await onSubmit({
      exchange: instrument.exchange || 'nse_cm',
      exchange_segment: instrument.exchangeSegment || 'NSE_CM',
      token: instrument.token,
      symbol: instrument.symbol || instrument.tradingSymbol,
      trading_symbol: instrument.tradingSymbol,
      transaction_type: side,
      product,
      order_type: orderType,
      quantity: String(qty),
      price: typeSpec.needsPrice ? String(Number(price) || 0) : '0',
      trigger_price: typeSpec.needsTrigger ? String(Number(trigger) || 0) : '0',
      source: 'MANUAL',
      // Only a genuinely observed live price. 0 means "park and wait".
      expected_ltp: hasPrice ? String(ltp) : '0',
    });
  };

  const canSubmit = Boolean(instrument) && Number(quantity) > 0 && !busy;
  const missingField =
    typeSpec.needsPrice && !(Number(price) > 0)
      ? 'a limit price is required'
      : typeSpec.needsTrigger && !(Number(trigger) > 0)
        ? 'a trigger price is required'
        : null;

  return (
    <Card className="shadow-soft">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm">New order</CardTitle>
        <Badge variant="outline" className={paper ? TONE_CLASS.amber : TONE_CLASS.sky}>
          {engine.state?.broker ?? '\u2014'}
          {paper ? ' \u00b7 PAPER' : ''}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* instrument */}
        <div className="space-y-1">
          <label className="text-[11px] text-muted-foreground">Instrument</label>
          {instrument ? (
            <div className="flex items-center justify-between rounded-md border border-white/10 bg-black/20 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {instrument.symbol || instrument.tradingSymbol}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {instrument.name || instrument.tradingSymbol}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm">{hasPrice ? fmtNum(ltp) : '\u2014'}</div>
                <div className="text-[10px] text-muted-foreground">
                  {hasPrice ? 'LTP (live)' : 'no live price'}
                </div>
              </div>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setInstrument(null)}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search symbol…"
                  className="h-9 pl-7 text-sm"
                />
              </div>
              {search.results.length > 0 && (
                <div className="max-h-48 overflow-auto rounded-md border border-white/10 bg-black/40">
                  {search.results.map((row) => (
                    <button
                      key={row.token || row.symbol}
                      onClick={() => {
                        setInstrument(row);
                        setQuery('');
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-white/5"
                    >
                      <span className="truncate">
                        <span className="font-medium">{row.symbol || row.tradingSymbol}</span>
                        <span className="ml-2 text-muted-foreground">{row.tradingSymbol}</span>
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {row.ltp != null ? fmtNum(row.ltp) : '\u2014'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {query.length >= 2 && search.status === 'empty' && (
                <p className="text-[10px] text-muted-foreground">No matching instruments.</p>
              )}
            </>
          )}
        </div>

        {/* side + type + product */}
        <div className="grid grid-cols-2 gap-2">
          <div className="grid grid-cols-2 gap-1 rounded-md border border-white/10 bg-black/20 p-1">
            {(['BUY', 'SELL'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSide(s)}
                className={`rounded px-2 py-1.5 text-xs font-medium transition ${
                  side === s
                    ? s === 'BUY'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-rose-500/20 text-rose-300'
                    : 'text-muted-foreground hover:bg-white/5'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value)}
            className="h-9 rounded-md border border-white/10 bg-black/20 px-2 text-xs"
          >
            {ORDER_TYPES.map((t) => (
              <option key={t.value} value={t.value} className="bg-slate-950">
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Qty</label>
            <Input
              value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ''))}
              className="h-9 text-sm"
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Price</label>
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder={typeSpec.needsPrice ? 'required' : 'n/a'}
              disabled={!typeSpec.needsPrice}
              className="h-9 text-sm"
              inputMode="decimal"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-muted-foreground">Trigger</label>
            <Input
              value={trigger}
              onChange={(e) => setTrigger(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder={typeSpec.needsTrigger ? 'required' : 'n/a'}
              disabled={!typeSpec.needsTrigger}
              className="h-9 text-sm"
              inputMode="decimal"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground">Product</label>
          {PRODUCTS.map((p) => (
            <button
              key={p}
              onClick={() => setProduct(p)}
              className={`rounded px-2 py-1 text-[11px] ${
                product === p
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:bg-white/5'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {intentPreview && (
          <p className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {intentPreview}
          </p>
        )}

        <Button className="w-full" onClick={submit} disabled={!canSubmit || Boolean(missingField)}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
          {missingField
            ? `Enter ${missingField}`
            : `Place ${side} order via Order Engine`}
        </Button>

        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          Every order goes through the Order Engine (validate → risk → audit → broker).{' '}
          {paper
            ? 'This is the paper terminal: orders fill from the real market feed, never from a generated price.'
            : `This is a live broker terminal — the order is sent straight to ${engine.state?.broker ?? 'the broker'}.`}
        </p>
      </CardContent>
    </Card>
  );
}