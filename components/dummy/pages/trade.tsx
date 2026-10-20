'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, ShoppingCart, Zap, Clock, RefreshCw, X, Pencil, Star, Bell,
  Trash2, FolderPlus, CheckSquare,
  Minus, Plus, AlertTriangle,
  Loader2, CircleDollarSign, Eye, EyeOff, TrendingUp, TrendingDown,
  ChevronDown, ChevronUp, Package,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { MetricCard, StatusBadge, ErrorState, SectionCard } from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { useRealtime } from '@/components/realtime-provider';
import { getQuote, placeDemoOrder, cancelDemoOrder } from '@/lib/api';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import {
  SEARCH_SUGGESTION_LIMIT, normalizeSearchResult, type CanonicalInstrument,
} from '@/lib/instrument-search';
import {
  modifyDummyOrder, equityLabel, orderStatusTone, getDummyOrderPreview,
  createDummyAlert, addDummyWatchlistSymbol,
  createDummyBasket, executeDummyBasket, getDummyWatchlists, type OrderPreview,
} from '@/lib/dummy';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { DummyThemedPage, DummyBadge, LivePulse } from '@/components/dummy/ui';
import { OrdersTabs } from '@/components/orders/orders-tabs';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type QuoteDetail = {
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number;
  avgPrice: number;
  totalBuyQty: number;
  totalSellQty: number;
  bestBidPrice: number;
  bestBidQty: number;
  bestAskPrice: number;
  bestAskQty: number;
  upperCircuit: number;
  lowerCircuit: number;
  lastUpdated: string;
};

type BasketLine = {
  key: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  token: string;
  transactionType: string;
  product: string;
  orderType: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  ltp: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(v?: number | null): string {
  return v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function DataQualityBadge({ live, wsState }: { live: boolean; wsState: string }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
      live ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-amber-500/40 bg-amber-500/10 text-amber-500',
    )}>
      {live ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
      {live ? 'LIVE' : wsState ? wsState : 'STALE'}
    </span>
  );
}

function formatExchange(ex?: string): string {
  if (!ex) return 'NSE';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').toUpperCase();
}

function StockSideColor(row: CanonicalInstrument): string {
  if (row.change != null && row.change > 0) return 'border-l-emerald-500';
  if (row.change != null && row.change < 0) return 'border-l-red-500';
  return 'border-l-muted-foreground/30';
}

/**
 * Watchlist symbols and restored drafts only know their symbol, so they are
 * folded through the same canonical normaliser. Nothing is invented: every field
 * the Search Engine has not supplied stays null.
 */
function symbolOnlyInstrument(symbol: string): CanonicalInstrument {
  return normalizeSearchResult({ symbol, tradingSymbol: symbol, exchange: 'nse_cm', token: '' });
}

function PriceFlash({ ltp, prevLtp }: { ltp: number; prevLtp: number | null }) {
  const color = prevLtp == null
    ? 'text-foreground'
    : ltp > prevLtp
      ? 'text-emerald-400'
      : ltp < prevLtp
        ? 'text-red-400'
        : 'text-foreground';
  return <span className={cn('transition-colors duration-300', color)}>{fmt(ltp)}</span>;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function DummyTrade() {
  const { state, error, refresh } = useDummyState(3000);
  const { latest, connected: tickConnected } = useLatestTicks(true);
  const { brokerWsState } = useRealtime();

  // Search
  const [query, setQuery] = useState('');
  // Debounce, abort, stale-response guarding and caching are owned by the shared
  // Search Engine hook — this file keeps no timers of its own.
  const search = useInstrumentSearch(query, { limit: SEARCH_SUGGESTION_LIMIT });
  const results = search.results;
  const searching = search.status === 'debouncing' || search.status === 'loading';
  const [selected, setSelected] = useState<CanonicalInstrument | null>(null);
  const [quoteLtp, setQuoteLtp] = useState<number | null>(null);
  const [quoteDetail, setQuoteDetail] = useState<QuoteDetail | null>(null);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [hoveredSuggestion, setHoveredSuggestion] = useState<string | null>(null);
  const prevLtpRef = useRef<number | null>(null);

  // Order form
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [product, setProduct] = useState('MIS');
  const [orderType, setOrderType] = useState('MKT');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);

  // Basket mode
  const [basketMode, setBasketMode] = useState(false);
  const [basketLines, setBasketLines] = useState<BasketLine[]>([]);
  const [basketSubmitting, setBasketSubmitting] = useState(false);

  // Watchlist cards
  const [watchCards, setWatchCards] = useState<CanonicalInstrument[]>([]);

  const { toast } = useToast();

  // ----- Watchlist load -----
  useEffect(() => {
    let cancelled = false;
    try {
      const raw = window.localStorage.getItem('dummy.trade.draft');
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft?.symbol) {
          selectRow(symbolOnlyInstrument(draft.symbol));
          if (draft.side === 'BUY' || draft.side === 'SELL') setSide(draft.side);
          if (draft.quantity) setQuantity(String(draft.quantity));
          window.localStorage.removeItem('dummy.trade.draft');
        }
      }
    } catch {
      /* ignore malformed draft */
    }
    getDummyWatchlists()
      .then((res) => {
        if (cancelled) return;
        const items = res?.items ?? [];
        const active = items.find((l) => l.id === res?.activeId) ?? items[0];
        const syms = (active?.symbols ?? []).slice(0, 12).map((s) => s.symbol).filter(Boolean);
        setWatchCards(syms.map((s) => symbolOnlyInstrument(s)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Select instrument -----
  const selectRow = useCallback((row: CanonicalInstrument) => {
    setSelected(row);
    search.clear();
    setQuoteDetail(null);
    setPlaced(null);
    setPlaceError(null);
    prevLtpRef.current = null;
    setDetailsExpanded(false);
    const symbol = row.symbol;
    getQuote([{ symbol }], 'ltp')
      .then((res) => {
        const d = Array.isArray(res?.data) ? res.data[0] : res?.data;
        const ltp = Number(d?.ltp ?? d?.last_price ?? 0);
        if (ltp > 0) {
          setQuoteLtp(ltp);
          feedDummyLtp(symbol, ltp);
        }
        setQuoteDetail({
          ltp,
          change: Number(d?.change ?? 0),
          changePct: Number(d?.changePct ?? d?.percentageChange ?? 0),
          open: Number(d?.open ?? 0),
          high: Number(d?.high ?? d?.dayHigh ?? 0),
          low: Number(d?.low ?? d?.dayLow ?? 0),
          close: Number(d?.close ?? 0),
          volume: Number(d?.volume ?? 0),
          prevClose: Number(d?.close ?? d?.previous_close ?? 0),
          avgPrice: Number(d?.avgPrice ?? d?.average_price ?? 0),
          totalBuyQty: Number(d?.totalBuyQty ?? 0),
          totalSellQty: Number(d?.totalSellQty ?? 0),
          bestBidPrice: Number(d?.bestBidPrice ?? d?.depth?.buy?.[0]?.price ?? 0),
          bestBidQty: Number(d?.bestBidQty ?? d?.depth?.buy?.[0]?.quantity ?? 0),
          bestAskPrice: Number(d?.bestAskPrice ?? d?.depth?.sell?.[0]?.price ?? 0),
          bestAskQty: Number(d?.bestAskQty ?? d?.depth?.sell?.[0]?.quantity ?? 0),
          upperCircuit: Number(d?.upperCircuit ?? 0),
          lowerCircuit: Number(d?.lowerCircuit ?? 0),
          lastUpdated: String(d?.lastUpdated ?? d?.last_trade_time ?? ''),
        });
      })
      .catch(() => { setQuoteDetail(null); setQuoteLtp(null); });
  }, [search]);

  // ----- Live tick updates for selected instrument -----
  useEffect(() => {
    if (!selected) return;
    const t = latest.get(selected.symbol);
    if (t && typeof t.ltp === 'number' && t.ltp > 0) {
      prevLtpRef.current = quoteLtp;
      setQuoteLtp(t.ltp);
      feedDummyLtp(selected.symbol, t.ltp);
    }
  }, [latest, selected, quoteLtp]);

  // ----- Quantity controls -----
  const validQty = useMemo(() => {
    const q = parseInt(quantity, 10);
    return Number.isInteger(q) && q > 0 ? q : 0;
  }, [quantity]);

  const bumpQty = (delta: number) => {
    const next = Math.max(1, validQty + delta);
    setQuantity(String(next));
  };

  // ----- Validation -----
  const needsLimit = orderType === 'LMT' || orderType === 'SL';
  const needsTrigger = orderType === 'SL' || orderType === 'SL-M';

  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    if (!selected) errs.push('Select an instrument');
    if (validQty <= 0) errs.push('Quantity must be a positive integer');
    if (needsLimit && (!Number(price) || Number(price) <= 0)) errs.push('Limit price is required');
    if (needsTrigger && (!Number(triggerPrice) || Number(triggerPrice) <= 0)) errs.push('Trigger price is required');
    return errs;
  }, [selected, validQty, needsLimit, needsTrigger, price, triggerPrice]);

  const canPlace = validationErrors.length === 0;

  // ----- Margin preview -----
  useEffect(() => {
    if (!selected || !canPlace) { setPreview(null); return; }
    const t = window.setTimeout(() => {
      setPreviewPending(true);
      getDummyOrderPreview({
        symbol: selected.symbol,
        transactionType: side,
        product,
        orderType,
        quantity: validQty,
        price: Number(price || 0),
        triggerPrice: Number(triggerPrice || 0),
        ltp: Number(quoteLtp || 0),
      })
        .then((res) => setPreview(res ?? null))
        .catch(() => setPreview(null))
        .finally(() => setPreviewPending(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [selected, canPlace, side, product, orderType, validQty, price, triggerPrice, quoteLtp]);

  // ----- Place order -----
  const placeOrder = async () => {
    if (!selected || !canPlace) return;
    setPlacing(true);
    setPlaceError(null);
    setPlaced(null);
    try {
      const res = await placeDemoOrder({
        symbol: selected.symbol,
        tradingSymbol: selected.tradingSymbol || selected.symbol,
        token: selected.token,
        exchange: selected.exchange || 'nse_cm',
        transactionType: side,
        product,
        orderType,
        quantity: validQty,
        price: Number(price || 0),
        triggerPrice: Number(triggerPrice || 0),
        ltp: Number(quoteLtp || 0),
      });
      const order = res?.demoOrder;
      if (order) setPlaced(order.orderId);
      setShowConfirm(false);
      void refresh();
    } catch (e) {
      setPlaceError(e instanceof Error ? e.message : 'Order placement failed');
    } finally {
      setPlacing(false);
    }
  };

  // ----- Basket -----
  const addBasketLine = useCallback(() => {
    if (!selected || !canPlace) return;
    setBasketLines((prev) => [
      ...prev,
      {
        key: `${selected.symbol}-${Date.now()}`,
        symbol: selected.symbol,
        tradingSymbol: selected.tradingSymbol || selected.symbol,
        exchange: selected.exchange || 'nse_cm',
        token: selected.token,
        transactionType: side,
        product,
        orderType,
        quantity: validQty,
        price: Number(price || 0),
        triggerPrice: Number(triggerPrice || 0),
        ltp: Number(quoteLtp || 0),
      },
    ]);
    toast({ title: 'Added to basket', description: `${side} ${validQty} ${selected.symbol} queued.` });
  }, [selected, canPlace, side, product, orderType, validQty, quoteLtp, price, triggerPrice, toast]);

  const removeBasketLine = useCallback((key: string) => {
    setBasketLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const submitBasket = useCallback(async () => {
    if (basketLines.length === 0) return;
    setBasketSubmitting(true);
    try {
      const res = await createDummyBasket({
        name: `Basket ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        legs: basketLines.map((l) => ({
          symbol: l.symbol,
          tradingSymbol: l.tradingSymbol,
          exchange: l.exchange,
          token: l.token,
          transactionType: l.transactionType,
          product: l.product,
          orderType: l.orderType,
          quantity: l.quantity,
          price: l.price,
          triggerPrice: l.triggerPrice,
        })),
      });
      const id = res?.data?.id ?? res?.basket?.id;
      if (id) {
        await executeDummyBasket({ basketId: id, ltpMap: Object.fromEntries(basketLines.map((l) => [l.symbol, l.ltp])) });
        toast({ title: 'Basket submitted', description: `${basketLines.length} order${basketLines.length > 1 ? 's' : ''} sent to Dummy Broker.` });
        setBasketLines([]);
        void refresh();
      } else {
        toast({ variant: 'destructive', title: 'Basket create failed', description: 'No basket id returned.' });
      }
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Basket failed', description: e?.detail ?? e?.message });
    } finally {
      setBasketSubmitting(false);
    }
  }, [basketLines, toast, refresh]);

  // ----- Resting orders -----
  const resting = useMemo(
    () => (state?.orders || []).filter((o) => ['OPEN', 'TRIGGER_PENDING', 'PENDING'].includes(o.status)),
    [state?.orders],
  );

  const cancelOrder = async (orderId: string) => {
    try { await cancelDemoOrder(orderId); void refresh(); } catch { /* keep */ }
  };

  // ----- Modify -----
  const [modifyState, setModifyState] = useState<Record<string, { qty: string; lmt: string; trg: string }>>({});
  const setModify = (id: string, patch: Partial<{ qty: string; lmt: string; trg: string }>) => {
    setModifyState((prev) => {
      const cur = prev[id] || { qty: '', lmt: '', trg: '' };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  };
  const submitModify = async (id: string) => {
    const m = modifyState[id] || { qty: '', lmt: '', trg: '' };
    try {
      await modifyDummyOrder({
        orderId: id,
        price: Number(m.lmt || 0),
        triggerPrice: Number(m.trg || 0),
        quantity: parseInt(m.qty || '', 10) || 0,
      });
      void refresh();
    } catch { /* keep */ }
    setModifyState((prev) => ({ ...prev, [id]: { qty: '', lmt: '', trg: '' } }));
  };

  // ----- Watchlist helpers -----
  const addToWatchlist = useCallback(async () => {
    if (!selected) return;
    try {
      const lists = await getDummyWatchlists();
      const activeId = lists?.activeId;
      if (!activeId) { toast({ variant: 'destructive', title: 'No watchlist', description: 'Create a watchlist first.' }); return; }
      await addDummyWatchlistSymbol(activeId, { symbol: selected.symbol });
      toast({ title: 'Added to watchlist', description: `${selected.symbol} added.` });
    } catch (e: any) { toast({ variant: 'destructive', title: 'Add failed', description: e?.detail ?? e?.message }); }
  }, [selected, toast]);

  const addAlert = useCallback(async () => {
    if (!selected || !quoteLtp) return;
    try {
      const p = Number((quoteLtp * 1.02).toFixed(2));
      await createDummyAlert({ symbol: selected.symbol, condition: 'gt', price: p, cooldownSec: 30, note: '2% above last price' });
      toast({ title: 'Alert created', description: `${selected.symbol} alert at ${p}` });
    } catch (e: any) { toast({ variant: 'destructive', title: 'Alert failed', description: e?.detail ?? e?.message }); }
  }, [selected, quoteLtp, toast]);

  // ----- Derived state -----
  const a = state?.account;
  const isLive = tickConnected || brokerWsState === 'SUPERVISOR_CONNECTED' || brokerWsState === 'CONNECTED';
  const changeColor = (quoteDetail?.change ?? 0) >= 0 ? 'text-emerald-500' : 'text-red-500';

  const basketTotal = useMemo(() => {
    return basketLines.reduce((sum, l) => {
      const val = l.price > 0 ? l.price * l.quantity : l.ltp * l.quantity;
      return sum + val;
    }, 0);
  }, [basketLines]);

  if (error && !state) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  return (
    <DummyThemedPage>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Trade</h1>
          <DummyBadge />
          <DataQualityBadge live={isLive} wsState={brokerWsState} />
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <Button asChild size="sm" variant="outline"><a href="/trading/trade">Orders</a></Button>
          <Button variant="outline" size="sm" onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /> Refresh</Button>
        </div>
      </div>

      <OrdersTabs />

      {/* Top cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard icon={Zap} title="Balance" value={equityLabel(a?.balance ?? 0)} tone="success" loading={!a} />
        <MetricCard icon={CircleDollarSign} title="Free margin" value={equityLabel(a?.freeMargin ?? 0)} tone="success" loading={!a} />
        <MetricCard icon={AlertTriangle} title="Used margin" value={equityLabel(a?.usedMargin ?? 0)} tone="warning" loading={!a} />
        <MetricCard icon={ShoppingCart} title="Open orders" value={String(resting.length)} tone="warning" />
        <MetricCard icon={Clock} title="Today's orders" value={String(a?.dailyOrders ?? 0)} tone="neutral" />
      </div>

      {/* Main 2-column layout */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">

        {/* ===== LEFT: Instrument + Search + Watchlist ===== */}
        <div className="space-y-4 lg:col-span-3">

          {/* Enhanced Search */}
          <SectionCard title="Instrument Search" icon={Search}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search symbol, company, or token (e.g. RELIANCE, INFY, TCS)…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-10 pl-9 pr-9 text-sm"
                data-verify="dummy-trade-search"
              />
              {searching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {query && !searching && (
                <button className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => { setQuery(''); search.clear(); }}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Suggestion cards */}
            {results.length > 0 && (
              <div className="mt-3 space-y-2">
                {results.map((r) => {
                  const rLtp = latest.get(r.symbol);
                  const liveLtp = rLtp && typeof rLtp.ltp === 'number' && rLtp.ltp > 0 ? rLtp.ltp : r.ltp;
                  const chg = r.change;
                  const chgPct = r.changePct;
                  const isUp = chg != null && chg > 0;
                  const isDown = chg != null && chg < 0;
                  const borderColor = isUp ? 'border-l-emerald-500' : isDown ? 'border-l-red-500' : 'border-l-muted-foreground/30';
                  const priceColor = isUp ? 'text-emerald-500' : isDown ? 'text-red-500' : 'text-foreground';
                  const isHovered = hoveredSuggestion === r.symbol;
                  const margin1 = liveLtp ? liveLtp * 0.2 : 0;
                  const margin5 = margin1 * 5;
                  const margin10 = margin1 * 10;

                  return (
                    <div
                      key={`${r.exchange}-${r.token || r.symbol}`}
                      className={cn(
                        'group relative rounded-lg border border-border border-l-4 bg-card p-3 transition-all hover:shadow-md',
                        borderColor,
                      )}
                      onMouseEnter={() => setHoveredSuggestion(r.symbol)}
                      onMouseLeave={() => setHoveredSuggestion(null)}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{r.symbol}</span>
                            <span className="text-[10px] text-muted-foreground">{formatExchange(r.exchange || r.exchangeSegment)}</span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{r.tradingSymbol || r.symbol}{r.name ? ` — ${r.name}` : ''}</p>
                        </div>
                        <div className="text-right shrink-0">
                          {liveLtp != null && liveLtp > 0 ? (
                            <>
                              <div className={cn('text-lg font-bold tabular-nums', priceColor)}>
                                ₹{liveLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                              <div className="flex items-center justify-end gap-1.5 text-[11px] tabular-nums">
                                {isUp ? <TrendingUp className="h-3 w-3 text-emerald-500" /> : isDown ? <TrendingDown className="h-3 w-3 text-red-500" /> : null}
                                {chg != null ? (
                                  <span className={cn('font-medium', priceColor)}>
                                    {chg >= 0 ? '+' : ''}{chg.toFixed(2)}{chgPct != null ? ` (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)` : ''}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </div>
                              {r.volume != null && r.volume > 0 && (
                                <div className="mt-0.5 text-[10px] text-muted-foreground">
                                  Vol: {r.volume.toLocaleString('en-IN')}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-sm text-muted-foreground">—</div>
                          )}
                        </div>
                      </div>

                      {/* Hover margin tiers */}
                      {isHovered && liveLtp != null && liveLtp > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[10px] text-muted-foreground">
                          <span className="font-medium text-foreground">Margin preview:</span>
                          <span>1 qty = ₹{margin1.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          <span>· 5 qty = ₹{margin5.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          <span>· 10 qty = ₹{margin10.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      )}

                      {/* BUY / SELL buttons on suggestion card */}
                      <div className="mt-2 flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          size="sm"
                          className="h-7 flex-1 bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-semibold"
                          onClick={(e) => { e.stopPropagation(); setSide('BUY'); selectRow(r); }}
                        >
                          BUY
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 flex-1 bg-red-500 hover:bg-red-600 text-white text-[11px] font-semibold"
                          onClick={(e) => { e.stopPropagation(); setSide('SELL'); selectRow(r); }}
                        >
                          SELL
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {query && !searching && search.status === 'empty' && (
              <p className="mt-2 text-xs text-muted-foreground">No instruments found for &quot;{search.resolvedQuery}&quot;.</p>
            )}

            {search.status === 'error' && (
              <p className="mt-2 text-xs text-destructive">Search unavailable: {search.error ?? 'Unknown error'}</p>
            )}
          </SectionCard>

          {/* Selected Instrument Card */}
          {selected && (
            <div className="rounded-xl border border-border bg-card p-4" data-verify="instrument-header">
              {/* Symbol + exchange + company */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5">
                    <span className="text-2xl font-extrabold tracking-tight">{selected.symbol}</span>
                    <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5">{formatExchange(selected.exchange || selected.exchangeSegment)}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{selected.instrumentType || selected.series || 'EQ'}</Badge>
                  </div>
                  {selected.name && (
                    <p className="mt-1 text-sm text-muted-foreground truncate max-w-md">{selected.name}</p>
                  )}
                  {selected.tradingSymbol && selected.tradingSymbol !== selected.symbol && (
                    <p className="text-[11px] text-muted-foreground/60">{selected.tradingSymbol}</p>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <div className="flex items-center gap-2">
                    <LivePulse value={quoteLtp} className="text-3xl font-extrabold tabular-nums">
                      {quoteLtp ? (
                        <PriceFlash ltp={quoteLtp} prevLtp={prevLtpRef.current} />
                      ) : '—'}
                    </LivePulse>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { setSelected(null); setQuoteLtp(null); setQuoteDetail(null); }}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {quoteDetail?.ltp ? (
                    <div className={`text-sm tabular-nums font-semibold ${changeColor}`}>
                      {quoteDetail.change >= 0 ? '+' : ''}{quoteDetail.change.toFixed(2)} ({quoteDetail.changePct >= 0 ? '+' : ''}{quoteDetail.changePct.toFixed(2)}%)
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">No quote data</div>
                  )}
                </div>
              </div>

              {/* OHLCV compact grid */}
              {quoteDetail?.ltp ? (
                <div className="mt-4 grid grid-cols-3 gap-3 rounded-lg border border-border/50 bg-muted/20 p-3 sm:grid-cols-6">
                  <div className="text-center">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Open</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{fmt(quoteDetail.open)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">High</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-emerald-500">{fmt(quoteDetail.high)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Low</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-red-500">{fmt(quoteDetail.low)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Prev Close</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{fmt(quoteDetail.prevClose)}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Volume</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{(quoteDetail.volume || 0).toLocaleString('en-IN')}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Avg Price</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{fmt(quoteDetail.avgPrice)}</div>
                  </div>
                </div>
              ) : null}

              {/* Bid/Ask depth */}
              {quoteDetail && (quoteDetail.bestBidPrice > 0 || quoteDetail.bestAskPrice > 0) && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {quoteDetail.bestBidPrice > 0 && (
                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-center">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-emerald-500">Best Bid</div>
                      <div className="font-mono text-sm font-bold text-emerald-500 tabular-nums">₹{fmt(quoteDetail.bestBidPrice)}</div>
                      <div className="text-[10px] text-muted-foreground">{quoteDetail.bestBidQty} qty</div>
                    </div>
                  )}
                  {quoteDetail.bestAskPrice > 0 && (
                    <div className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-center">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-red-500">Best Ask</div>
                      <div className="font-mono text-sm font-bold text-red-500 tabular-nums">₹{fmt(quoteDetail.bestAskPrice)}</div>
                      <div className="text-[10px] text-muted-foreground">{quoteDetail.bestAskQty} qty</div>
                    </div>
                  )}
                </div>
              )}

              {/* Expandable full details */}
              <button
                onClick={() => setDetailsExpanded(!detailsExpanded)}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-border/50 bg-muted/20 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40"
              >
                {detailsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {detailsExpanded ? 'Hide' : 'Show'} full details
              </button>
              {detailsExpanded && quoteDetail && (
                <div className="mt-2 space-y-2 rounded-md border border-border/50 bg-muted/20 p-3">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs tabular-nums sm:grid-cols-3">
                    <div className="flex justify-between"><dt className="text-muted-foreground">Upper Circuit</dt><dd className="font-medium">{fmt(quoteDetail.upperCircuit)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Lower Circuit</dt><dd className="font-medium">{fmt(quoteDetail.lowerCircuit)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Close</dt><dd className="font-medium">{fmt(quoteDetail.close)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Total Buy Qty</dt><dd className="font-medium">{quoteDetail.totalBuyQty.toLocaleString('en-IN')}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Total Sell Qty</dt><dd className="font-medium">{quoteDetail.totalSellQty.toLocaleString('en-IN')}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Last Updated</dt><dd className="font-medium">{quoteDetail.lastUpdated || '—'}</dd></div>
                  </dl>
                  {selected.token ? (
                    <p className="text-[11px] text-muted-foreground">Token: {selected.token}{selected.exchangeSegment ? ` · ${selected.exchangeSegment}` : ''}</p>
                  ) : null}
                </div>
              )}

              {/* Quick actions */}
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/50 pt-3">
                <Button size="sm" variant="outline" onClick={() => void addToWatchlist()}>
                  <Star className="mr-1 h-3.5 w-3.5" /> Watchlist
                </Button>
                <Button size="sm" variant="outline" onClick={() => void addAlert()}>
                  <Bell className="mr-1 h-3.5 w-3.5" /> Alert
                </Button>
              </div>
            </div>
          )}

          {!selected && (
            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
              <Search className="mx-auto mb-3 h-8 w-8 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">Search for an instrument to begin trading</p>
              <p className="mt-1 text-xs text-muted-foreground/60">Type a symbol like RELIANCE, INFY, or TCS</p>
            </div>
          )}

          {/* Watchlist Cards with live LTP */}
          {watchCards.length > 0 && (
            <SectionCard title="Watchlist" icon={Star}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {watchCards.map((c) => {
                  const t = latest.get(c.symbol);
                  const ltp = t && typeof t.ltp === 'number' ? t.ltp : null;
                  const chg = t && typeof t.ltp === 'number' ? (t as any).change : null;
                  const isUp = chg != null && chg > 0;
                  const isDown = chg != null && chg < 0;
                  return (
                    <button
                      key={c.symbol}
                      type="button"
                      onClick={() => selectRow(c)}
                      className={cn(
                        'rounded-lg border bg-background px-2.5 py-2 text-left transition-all hover:border-primary/40 hover:shadow-sm',
                        selected?.symbol === c.symbol && 'border-primary/60 bg-primary/5',
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-bold truncate">{c.symbol}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">NSE</span>
                      </div>
                      <div className={cn(
                        'mt-0.5 font-mono text-sm font-semibold tabular-nums',
                        isUp ? 'text-emerald-500' : isDown ? 'text-red-500' : 'text-foreground',
                      )}>
                        {ltp ? `₹${ltp.toFixed(2)}` : '—'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </SectionCard>
          )}
        </div>

        {/* ===== RIGHT: Order Entry + Basket + Resting Orders ===== */}
        <div className="space-y-4 lg:col-span-2">

          {/* Order Entry */}
          <SectionCard title={basketMode ? 'Basket Order Entry' : 'Order Entry'} icon={ShoppingCart}>
            <div className="space-y-4">

              {/* BUY / SELL toggle */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSide('BUY')}
                  className={cn(
                    'rounded-lg border-2 py-2.5 text-sm font-bold tracking-wide transition-all',
                    side === 'BUY'
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500 shadow-sm shadow-emerald-500/20'
                      : 'border-border bg-background text-muted-foreground hover:border-emerald-500/30',
                  )}
                  data-verify="buy-button"
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setSide('SELL')}
                  className={cn(
                    'rounded-lg border-2 py-2.5 text-sm font-bold tracking-wide transition-all',
                    side === 'SELL'
                      ? 'border-red-500 bg-red-500/10 text-red-500 shadow-sm shadow-red-500/20'
                      : 'border-border bg-background text-muted-foreground hover:border-red-500/30',
                  )}
                  data-verify="sell-button"
                >
                  SELL
                </button>
              </div>

              {/* Product + Order Type */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Product</Label>
                  <Select value={product} onValueChange={setProduct}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MIS">MIS — Intraday</SelectItem>
                      <SelectItem value="NRM">NRM — Delivery</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Order Type</Label>
                  <Select value={orderType} onValueChange={setOrderType}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MKT">MARKET</SelectItem>
                      <SelectItem value="LMT">LIMIT</SelectItem>
                      <SelectItem value="SL">SL-LIMIT</SelectItem>
                      <SelectItem value="SL-M">SL-MARKET</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Quantity */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Quantity</Label>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => bumpQty(-1)}>
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="h-9 text-center font-mono text-sm tabular-nums"
                  />
                  <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => bumpQty(1)}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Price (for LMT / SL) */}
              {needsLimit && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Limit Price</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.05"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="0.00"
                    className="h-9 font-mono text-sm tabular-nums"
                  />
                </div>
              )}

              {/* Trigger Price (for SL / SL-M) */}
              {needsTrigger && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">Trigger Price</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.05"
                    value={triggerPrice}
                    onChange={(e) => setTriggerPrice(e.target.value)}
                    placeholder="0.00"
                    className="h-9 font-mono text-sm tabular-nums"
                  />
                </div>
              )}

              {/* Validation errors */}
              {validationErrors.length > 0 && (
                <div className="space-y-1">
                  {validationErrors.map((err) => (
                    <p key={err} className="text-[11px] text-amber-500 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> {err}
                    </p>
                  ))}
                </div>
              )}

              {/* Market order hint */}
              {quoteLtp && orderType === 'MKT' && selected && (
                <p className="text-[11px] text-muted-foreground">
                  Market order fills at real LTP (₹{quoteLtp.toFixed(2)}) with ±0.1% slippage.
                </p>
              )}

              {/* Live margin preview */}
              {preview && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Order Summary</span>
                    {previewPending && <span className="text-[10px] text-muted-foreground">calculating…</span>}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs tabular-nums">
                    <div className="flex justify-between"><dt className="text-muted-foreground">Order value</dt><dd className="font-medium">₹{fmt(preview.baseValue)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Est. price</dt><dd className="font-medium">₹{fmt(preview.estimatedPrice)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Charges</dt><dd className="font-medium">₹{fmt(preview.charges?.total)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Margin needed</dt><dd className="font-medium">₹{fmt(preview.marginRequired)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Available</dt><dd className="font-medium">₹{fmt(preview.freeMargin)}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Post-order free</dt><dd className="font-medium">₹{fmt(preview.remainingAfterBuy)}</dd></div>
                  </dl>
                  <div className={cn(
                    'rounded-md px-2.5 py-1.5 text-center text-xs font-medium',
                    preview.sufficient ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500',
                  )}>
                    {preview.sufficient
                      ? `Sufficient margin — ₹${fmt(preview.remainingAfterBuy)} free after order`
                      : 'Insufficient margin — this order will be rejected'}
                  </div>
                </div>
              )}

              {/* Placed / Error */}
              {placed && (
                <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
                  Order placed — {placed}
                </div>
              )}
              {placeError && (
                <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
                  {placeError}
                </div>
              )}

              {/* Basket mode toggle */}
              <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                <label htmlFor="basket-mode" className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                  <Checkbox id="basket-mode" checked={basketMode} onCheckedChange={(v) => setBasketMode(Boolean(v))} />
                  Basket mode
                </label>
                <span className="text-[11px] text-muted-foreground">
                  {basketMode ? `${basketLines.length} leg${basketLines.length === 1 ? '' : 's'}` : 'Queue multiple orders'}
                </span>
              </div>

              {/* Action buttons */}
              {basketMode ? (
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    className="w-full h-9 text-sm font-semibold"
                    disabled={!canPlace || !selected}
                    onClick={() => void addBasketLine()}
                  >
                    <FolderPlus className="mr-1.5 h-4 w-4" /> Add to Basket
                  </Button>
                  <Button
                    className="w-full h-10 font-semibold"
                    disabled={basketLines.length === 0 || basketSubmitting}
                    onClick={() => void submitBasket()}
                  >
                    {basketSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckSquare className="mr-2 h-4 w-4" />}
                    Execute Basket ({basketLines.length})
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    className="w-full h-9 text-sm font-semibold"
                    disabled={!canPlace || !selected}
                    onClick={() => void addBasketLine()}
                  >
                    <FolderPlus className="mr-1.5 h-4 w-4" /> Add to Basket
                  </Button>
                  <Button
                    className={cn(
                      'w-full h-11 text-sm font-bold',
                      side === 'BUY' ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-red-500 hover:bg-red-600 text-white',
                    )}
                    disabled={!canPlace || placing}
                    onClick={() => setShowConfirm(true)}
                    data-verify="place-order-button"
                  >
                    {placing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {placing ? 'Placing…' : `Place ${side} Order`}
                  </Button>
                </div>
              )}
            </div>
          </SectionCard>

          {/* Basket legs (when active) */}
          {basketMode && basketLines.length > 0 && (
            <SectionCard title="Basket Legs" icon={Package}>
              <div className="space-y-1.5">
                {basketLines.map((l) => (
                  <div key={l.key} className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                    <CheckSquare className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span className="font-bold">{l.symbol}</span>
                    <Badge
                      variant={l.transactionType === 'BUY' ? 'default' : 'destructive'}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {l.transactionType}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {l.product}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {l.orderType}
                    </Badge>
                    <span className="text-muted-foreground">×{l.quantity}</span>
                    <span className="text-muted-foreground">{l.price ? `@ ₹${fmt(l.price)}` : '@ Mkt'}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                      ₹{fmt(l.price > 0 ? l.price * l.quantity : l.ltp * l.quantity)}
                    </span>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => removeBasketLine(l.key)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-semibold">
                  <span>Total</span>
                  <span className="font-mono tabular-nums">₹{basketTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            </SectionCard>
          )}

          {/* Resting Orders */}
          <SectionCard title={`Resting Orders (${resting.length})`} icon={Clock}>
            {resting.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">No resting limit/stop orders.</p>
            ) : (
              <div className="space-y-2">
                {resting.slice(0, 5).map((o) => (
                  <div key={o.orderId} className="rounded-md border p-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{o.symbol}</span>
                        <Badge variant={o.transactionType === 'BUY' ? 'default' : 'destructive'} className="text-[10px]">{o.transactionType}</Badge>
                        <StatusBadge status={orderStatusTone(o.status)} label={o.status} />
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground">{o.orderId}</span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-end gap-1.5 text-[11px]">
                      <span className="text-muted-foreground">Qty {o.quantity}</span>
                      {o.price ? <span className="text-muted-foreground">Lmt ₹{o.price}</span> : null}
                      {o.triggerPrice ? <span className="text-muted-foreground">Trg ₹{o.triggerPrice}</span> : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Input type="number" className="h-7 w-16 text-[11px]" placeholder="qty" value={modifyState[o.orderId]?.qty ?? ''} onChange={(e) => setModify(o.orderId, { qty: e.target.value })} />
                      <Input type="number" className="h-7 w-20 text-[11px]" placeholder="lmt" value={modifyState[o.orderId]?.lmt ?? ''} onChange={(e) => setModify(o.orderId, { lmt: e.target.value })} />
                      <Input type="number" className="h-7 w-20 text-[11px]" placeholder="trg" value={modifyState[o.orderId]?.trg ?? ''} onChange={(e) => setModify(o.orderId, { trg: e.target.value })} />
                      <Button size="sm" variant="outline" className="h-7" onClick={() => void submitModify(o.orderId)}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="destructive" className="h-7" onClick={() => void cancelOrder(o.orderId)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      {/* Order Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Confirm {side} Order
              {selected && <Badge variant="outline">{selected.symbol}</Badge>}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3">
              <div className={cn(
                'rounded-lg px-4 py-3 text-center font-bold',
                side === 'BUY' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500',
              )}>
                {side} {validQty} × {selected.symbol}
              </div>
              <dl className="space-y-1.5 text-sm tabular-nums">
                <div className="flex justify-between"><dt className="text-muted-foreground">Product</dt><dd className="font-medium">{product}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Order Type</dt><dd className="font-medium">{orderType === 'MKT' ? 'MARKET' : orderType === 'LMT' ? 'LIMIT' : orderType}</dd></div>
                {needsLimit && <div className="flex justify-between"><dt className="text-muted-foreground">Price</dt><dd className="font-medium">₹{Number(price).toFixed(2)}</dd></div>}
                {needsTrigger && <div className="flex justify-between"><dt className="text-muted-foreground">Trigger</dt><dd className="font-medium">₹{Number(triggerPrice).toFixed(2)}</dd></div>}
                <div className="flex justify-between"><dt className="text-muted-foreground">Est. value</dt><dd className="font-medium">₹{fmt(preview?.baseValue)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Charges</dt><dd className="font-medium">₹{fmt(preview?.charges?.total)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Margin required</dt><dd className="font-medium">₹{fmt(preview?.marginRequired)}</dd></div>
              </dl>
              {preview && !preview.sufficient && (
                <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500 text-center">
                  Insufficient margin — order will be rejected
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>Cancel</Button>
            <Button
              disabled={!canPlace || placing}
              onClick={() => void placeOrder()}
              className={side === 'BUY' ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-red-500 hover:bg-red-600'}
            >
              {placing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {placing ? 'Placing…' : `Place ${side} Order`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DummyThemedPage>
  );
}
