'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import {
  TrendingUp, TrendingDown, AlertCircle, ChevronDown, ChevronUp,
  Shield, Target, AlertTriangle, Loader2,
  Info, ArrowLeft, Clock, Minus, Plus, BarChart3, Crosshair,
  IndianRupee, Activity, CircleDot, Layers, SlidersHorizontal, Hash, Coins,
  Zap, CheckCircle2, Package,
} from 'lucide-react';

const BasketOrderPanel = dynamic(() => import('./basket-order-panel'), { ssr: false });
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { StockResult } from './stock-search';
import { getQuote, getTickStreamUrl } from '@/lib/api';
import type { QuoteDataRaw } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { getSettingsStore, useAccountMode } from '@/lib/settings-store';
import { cn } from '@/lib/utils';
import { calculateCharges, type ChargeCalculation } from '@/lib/charge-engine';
import { positionKey } from '@/lib/charge-service';
import { getTriggerStore, useTriggers } from '@/lib/trigger-store';
import { useTriggerEngine } from '@/hooks/use-trigger-engine';

type QuoteData = {
  ltp: number;
  prevClose: number;
  change: number;
  changePct: number;
  upperCircuit: number;
  lowerCircuit: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  avgPrice: number;
  totalBuyQty: number;
  totalSellQty: number;
  bestBidPrice: number;
  bestBidQty: number;
  bestAskPrice: number;
  bestAskQty: number;
  lastUpdated: string;
  status: 'LIVE' | 'STALE' | 'DISCONNECTED';
};

type OrderForm = {
  transactionType: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: string;
  price: string;
  disclosedQty: string;
  validity: string;
  amo: string;
  slPrice: string;
  targetPrice: string;
};

type FundsData = { availableMargin: number; usedMargin: number; collateralMargin: number };
type ExistingPosition = { symbol: string; netQty: number; product: string; avgPrice: number; ltp: number; unrealised: number } | null;

type SquareOffResult = { reason: 'target' | 'sl'; ok: boolean; detail: string };

type Props = {
  stock: StockResult;
  initialSide?: 'BUY' | 'SELL';
  onOrderPlaced: (result: any) => void;
  onBack: () => void;
};

/* Exact values supported by the backend contract (python-service PlaceOrderRequest):
   product: 'MIS' | 'CNC' — order_type: 'MKT' | 'L' | 'SL' | 'SL-M'.
   There is NO exchange-native Target order type; the target below maps to the
   app's existing live monitor + real square-off endpoint. */
const PRODUCTS = [
  { value: 'MIS', label: 'MIS', desc: 'Intraday', detail: 'Execute within the same trading day', intraday: true },
  { value: 'CNC', label: 'CNC', desc: 'Delivery', detail: 'Hold overnight, convert to delivery', intraday: false },
];

const ORDER_TYPES = [
  { value: 'L', label: 'Limit', desc: 'Execute at your price or better' },
  { value: 'MKT', label: 'Market', desc: 'Execute now at the best available price' },
] as const;

type OrderTypeValue = (typeof ORDER_TYPES)[number]['value'];
const isMarketLike = (ot: string) => ot === 'MKT';
const needsLimitPrice = (ot: string) => ot === 'L';

function formatINR(val: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

function signedINR(val: number): string {
  if (!Number.isFinite(val)) return '—';
  if (val === 0) return '₹0.00';
  return `${val > 0 ? '+' : '-'}${formatINR(Math.abs(val))}`;
}

function signedPct(val: number): string {
  if (!Number.isFinite(val)) return '';
  return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
}

function formatCompact(val: number): string {
  if (val >= 1e7) return (val / 1e7).toFixed(1) + 'Cr';
  if (val >= 1e5) return (val / 1e5).toFixed(1) + 'L';
  if (val >= 1e3) return (val / 1e3).toFixed(1) + 'K';
  return val.toLocaleString('en-IN');
}

function isMarketOpen(): boolean {
  try {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= 555 && mins <= 930;
  } catch { return true; }
}

function getMarketStatusText(): string {
  try {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();
    if (day === 0 || day === 6) return 'Weekend';
    const mins = ist.getHours() * 60 + ist.getMinutes();
    if (mins < 555) return 'Pre-market';
    if (mins > 930) return 'Closed';
    return 'Open';
  } catch { return 'Unknown'; }
}

function getMarketStatusColor(): string {
  const status = getMarketStatusText();
  if (status === 'Open') return 'bg-success/15 text-success border-success/30';
  if (status === 'Pre-market') return 'bg-info/15 text-info border-info/30';
  return 'bg-warning/15 text-warning border-warning/30';
}

function num(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val !== '') { const n = parseFloat(val); return isNaN(n) ? 0 : n; }
  return 0;
}

function extractFirstQuote(data: any): QuoteDataRaw {
  const d = data?.data;
  if (Array.isArray(d)) return d[0] || {};
  if (d && typeof d === 'object') return d;
  return {};
}

function extractQuoteData(raw: QuoteDataRaw): QuoteData {
  const ohlc = raw.ohlc || {};
  const depth = raw.depth || {};
  const buyDepth = Array.isArray(depth.buy) ? depth.buy : [];
  const sellDepth = Array.isArray(depth.sell) ? depth.sell : [];
  const ltp = num(raw.ltp || raw.last_price);
  const prevClose = num(ohlc.close || raw.close || raw.previous_close);
  const change = ltp > 0 && prevClose > 0 ? ltp - prevClose : 0;
  const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

  return {
    ltp, prevClose, change, changePct,
    upperCircuit: num(raw.upper_circuit), lowerCircuit: num(raw.lower_circuit),
    open: num(ohlc.open), high: num(ohlc.high), low: num(ohlc.low), close: num(ohlc.close),
    volume: num(raw.volume), avgPrice: num(raw.average_price),
    totalBuyQty: num(raw.total_buy_qty), totalSellQty: num(raw.total_sell_qty),
    bestBidPrice: buyDepth.length > 0 ? num(buyDepth[0].price) : 0,
    bestBidQty: buyDepth.length > 0 ? num(buyDepth[0].quantity) : 0,
    bestAskPrice: sellDepth.length > 0 ? num(sellDepth[0].price) : 0,
    bestAskQty: sellDepth.length > 0 ? num(sellDepth[0].quantity) : 0,
    lastUpdated: new Date().toISOString(), status: 'LIVE',
  };
}

/** Charge estimates come from THE canonical charge engine (lib/charge-engine.ts)
 * via the shared configured rate tables — the single source of truth for every
 * page and mode. Always presented as an estimate until the broker confirms. */
function toChargeRows(c: ChargeCalculation): {
  brokerage: number; stt: number; exchangeTxn: number; gst: number; sebi: number; stampDuty: number; total: number;
} {
  return {
    brokerage: c.brokerage,
    stt: c.stt,
    exchangeTxn: c.exchangeTransactionCharges,
    gst: c.gst,
    sebi: c.sebiCharges,
    stampDuty: c.stampDuty,
    total: c.totalCharges,
  };
}

const PRODUCT_VALUES: string[] = PRODUCTS.map(p => p.value);
function safeProduct(v: string): string {
  return PRODUCT_VALUES.includes(v) ? v : 'MIS';
}
function safeOrderType(v: string): OrderTypeValue {
  return v === 'MKT' || v === 'L' ? (v as OrderTypeValue) : 'L';
}

export default function OrderEntry({ stock, initialSide, onOrderPlaced, onBack }: Props) {
  const settingsStore = getSettingsStore();
  const settings = settingsStore.getSettings();
  const accountMode = useAccountMode();
  const isDemo = accountMode === 'demo';

  const initialFormWithDefaults: OrderForm = {
    transactionType: initialSide ?? settings.orderDefaults.side,
    product: safeProduct(settings.orderDefaults.product),
    orderType: 'L',
    quantity: String(settings.orderDefaults.quantity),
    price: '0', disclosedQty: '0',
    validity: settings.orderDefaults.validity, amo: 'NO',
    slPrice: settings.stopLoss.mode === 'FIXED' && settings.stopLoss.enabled ? String(settings.stopLoss.value) : '',
    targetPrice: settings.target.mode === 'FIXED' && settings.target.enabled ? String(settings.target.value) : '',
  };

  const [form, setForm] = useState<OrderForm>({ ...initialFormWithDefaults });
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [funds, setFunds] = useState<FundsData | null>(null);
  const [position, setPosition] = useState<ExistingPosition>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [squareOffResult, setSquareOffResult] = useState<SquareOffResult | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const basketRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { evaluateTriggers } = useTriggerEngine();
  const allTriggers = useTriggers();
  const liveTrigger = useMemo(
    () => allTriggers.find(
      (t) => t.status === 'ARMED' && String(t.token) === String(stock.token),
    ) ?? null,
    [allTriggers, stock.token],
  );
  const lastTriggerOutcome = useMemo(
    () => allTriggers.find((t) => String(t.token) === String(stock.token) && t.status !== 'ARMED') ?? null,
    [allTriggers, stock.token],
  );

  const marketOpen = useMemo(() => isMarketOpen(), []);
  const marketStatusText = useMemo(() => getMarketStatusText(), []);

  const updateForm = useCallback((patch: Partial<OrderForm>) => {
    setForm(prev => ({ ...prev, ...patch }));
  }, []);

  const handleOrderTypeChange = useCallback((nextType: string) => {
    setForm(prev => {
      const next = { ...prev, orderType: nextType };
      if (!needsLimitPrice(nextType)) { next.price = '0'; }
      return next;
    });
  }, []);

  const fetchQuote = useCallback(async () => {
    try {
      const data = await getQuote([{ instrument_token: stock.token, exchange_segment: stock.exchange }], 'ltp');
      const raw = extractFirstQuote(data);
      const newLtp = num(raw.ltp || raw.last_price);
      setQuote(prev => {
        if (!prev || prev.status === 'DISCONNECTED') return { ...extractQuoteData(raw), status: newLtp > 0 ? 'LIVE' : 'STALE' };
        if (newLtp <= 0) return { ...prev, status: 'STALE' };
        return { ...extractQuoteData(raw), status: 'LIVE' };
      });
    } catch {
      setQuote(prev => prev ? { ...prev, status: 'DISCONNECTED' } : prev);
    }
  }, [stock.token, stock.exchange]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setQuoteLoading(true);
      try {
        const data = await getQuote([{ instrument_token: stock.token, exchange_segment: stock.exchange }], 'ltp');
        if (cancelled) return;
        setQuote({ ...extractQuoteData(extractFirstQuote(data)) });
      } catch { if (!cancelled) setQuote(null); }
      finally { if (!cancelled) setQuoteLoading(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [stock.token, stock.exchange]);

  useEffect(() => { const timer = setInterval(fetchQuote, 5000); return () => clearInterval(timer); }, [fetchQuote]);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnect: NodeJS.Timeout | null = null;
    const connect = () => {
      try {
        es = new EventSource(getTickStreamUrl());
        es.onmessage = (event) => {
          try {
            const t = JSON.parse(event.data);
            if (t.ltp == null || t.ltp === 0) return;
            const tokenMatch = t.instrumentToken != null && String(t.instrumentToken) === String(stock.token);
            const tsymMatch = t.tradingSymbol != null && stock.tradingSymbol != null &&
              String(t.tradingSymbol).toUpperCase() === stock.tradingSymbol.toUpperCase();
            const symMatch = t.symbol != null && stock.symbol != null &&
              String(t.symbol).toUpperCase() === stock.symbol.toUpperCase();
            if (!tokenMatch && !tsymMatch && !symMatch) return;
            setQuote(prev => prev ? { ...prev, ltp: Number(t.ltp), status: 'LIVE', lastUpdated: new Date().toISOString() } : prev);
          } catch { /* ignore */ }
        };
        es.onerror = () => {
          es?.close(); es = null;
          reconnect = setTimeout(connect, 3000);
        };
      } catch {
        reconnect = setTimeout(connect, 3000);
      }
    };
    connect();
    return () => { es?.close(); if (reconnect) clearTimeout(reconnect); };
  }, [stock.token, stock.symbol, stock.tradingSymbol]);

  useEffect(() => {
    let cancelled = false;
    const fetchFunds = async () => {
      try {
        const { TradingService } = await import('@/lib/trading-service');
        const fundsResult = await TradingService.getFunds();
        if (!cancelled) setFunds({ availableMargin: fundsResult.availableMargin || 0, usedMargin: fundsResult.usedMargin || 0, collateralMargin: 0 });
      } catch { if (!cancelled) setFunds(null); }
    };
    fetchFunds();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkPosition = async () => {
      try {
        const { TradingService } = await import('@/lib/trading-service');
        const data = await TradingService.getPositions();
        if (cancelled) return;
        const positions = Array.isArray(data?.data) ? data.data : [];
        const found = positions.find((p: any) => {
          const cleanSym = (p.sym_clean || p.sym || '').toUpperCase();
          const stockSym = stock.symbol.toUpperCase();
          return cleanSym === stockSym || (p.trdSym_clean || p.trdSym || '').toUpperCase().includes(stockSym);
        });
        if (found) {
          setPosition({
            symbol: found.sym_clean || found.symbol || stock.symbol,
            netQty: found.net_qty || 0, product: found.prod_clean || found.product || '',
            avgPrice: found.avg_price || found.average_price || 0,
            ltp: found.ltp || 0, unrealised: found.unrealised || 0,
          });
        } else { setPosition(null); }
      } catch { setPosition(null); }
    };
    checkPosition();
    return () => { cancelled = true; };
  }, [stock.symbol]);

  useEffect(() => {
    if (form.orderType === 'MKT') updateForm({ price: '0' });
    else if (form.orderType === 'L' && quote?.ltp && parseFloat(form.price) === 0) updateForm({ price: quote.ltp.toFixed(2) });
  }, [form.orderType, quote?.ltp]);

  useEffect(() => {
    if (!marketOpen && form.amo === 'NO') updateForm({ amo: 'YES' });
  }, [marketOpen, form.amo, updateForm]);

  const validation = useMemo(() => {
    const fieldErrors: { quantity?: string; limitPrice?: string; stopLoss?: string; target?: string } = {};
    const qty = parseInt(form.quantity, 10);
    const price = parseFloat(form.price);
    const ltp = quote?.ltp || 0;
    const side = form.transactionType;

    if (!Number.isInteger(qty) || qty <= 0) fieldErrors.quantity = 'Enter a whole number greater than 0';
    if (needsLimitPrice(form.orderType) && (!Number.isFinite(price) || price <= 0)) {
      fieldErrors.limitPrice = 'Enter a positive limit price';
    }

    let target: number | null = null;
    if (form.targetPrice.trim() !== '') {
      const t = parseFloat(form.targetPrice);
      if (!Number.isFinite(t) || t <= 0) {
        fieldErrors.target = 'Enter a positive target price';
      } else {
        target = t;
        if (ltp > 0) {
          if (side === 'BUY' && t <= ltp) fieldErrors.target = 'BUY target should be above LTP';
          if (side === 'SELL' && t >= ltp) fieldErrors.target = 'SELL target should be below LTP';
        }
      }
    }

    let sl: number | null = null;
    if (form.slPrice.trim() !== '') {
      const s = parseFloat(form.slPrice);
      if (!Number.isFinite(s) || s <= 0) {
        fieldErrors.stopLoss = 'Enter a positive stop-loss price';
      } else {
        sl = s;
        if (ltp > 0) {
          if (side === 'BUY' && s >= ltp) fieldErrors.stopLoss = 'BUY stop loss should be below LTP';
          if (side === 'SELL' && s <= ltp) fieldErrors.stopLoss = 'SELL stop loss should be above LTP';
        }
      }
    }

    const refPrice = isMarketLike(form.orderType)
      ? ltp
      : (Number.isFinite(price) && price > 0 ? price : 0);
    const orderValue = qty * refPrice;
    const requiredMargin = form.product === 'MIS' ? orderValue * 0.2 : orderValue;
    const available = funds?.availableMargin || 0;
    const charges = toChargeRows(calculateCharges({
      side, quantity: qty, price: refPrice,
      product: form.product,
      exchange: stock.exchangeSegment || stock.exchange,
      timestamp: new Date(),
    }));
    const totalRequired = requiredMargin + charges.total;

    const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
    const exitCharges = target != null
      ? toChargeRows(calculateCharges({
          side: exitSide, quantity: qty, price: target,
          product: form.product,
          exchange: stock.exchangeSegment || stock.exchange,
          timestamp: new Date(),
        }))
      : null;

    return {
      fieldErrors, valid: Object.keys(fieldErrors).length === 0,
      qty, refPrice, orderValue, requiredMargin, charges,
      totalRequired, availableMargin: available, remainingMargin: available - totalRequired,
      hasShortfall: totalRequired > available && available > 0,
      target, sl, exitSide, exitCharges,
      totalEstimatedCharges: charges.total + (exitCharges?.total ?? 0),
    };
  }, [form, quote, funds, stock]);

  const handlePlaceOrder = async () => {
    if (!validation.valid) return;
    setPlacing(true);
    try {
      const { TradingService } = await import('@/lib/trading-service');
      const result = await TradingService.placeOrder({
        exchange: stock.exchange, symbol: stock.symbol, token: stock.token,
        tradingSymbol: stock.tradingSymbol || stock.symbol,
        exchangeSegment: stock.exchangeSegment || stock.exchange,
        transaction_type: form.transactionType, product: form.product,
        order_type: form.orderType, quantity: form.quantity,
        price: needsLimitPrice(form.orderType) ? form.price : '0',
        trigger_price: '0',
        disclosed_quantity: form.disclosedQty || '0', validity: form.validity, amo: form.amo,
        ltp: quote?.ltp || 0,
      });

      const stat = result?.data?.stat ?? result?.stat ?? null;
      const rejected = stat === 'NotOk' || result?.demoOrder?.status === 'REJECTED';
      if (rejected) {
        toast({
          title: 'Order Rejected',
          description: result?.data?.remarks || result?.demoOrder?.errorMessage || 'The backend rejected this order.',
          variant: 'destructive',
        });
        return;
      }

      const placedTarget = validation.target != null && validation.target > 0 ? validation.target : null;
      const placedSl = validation.sl != null && validation.sl > 0 ? validation.sl : null;
      if (placedTarget != null || placedSl != null) {
        const store = getTriggerStore();
        const orderId = String(
          result?.data?.n_ord_no ?? result?.demoOrder?.orderId ?? '',
        );
        const base = {
          positionId: positionKey(stock.symbol, form.product),
          orderId: orderId || null,
          symbol: stock.symbol,
          tradingSymbol: stock.tradingSymbol || stock.symbol,
          companyName: stock.companyName,
          token: stock.token,
          exchange: stock.exchange,
          exchangeSegment: stock.exchangeSegment || stock.exchange,
          product: form.product,
          side: form.transactionType,
          quantity: parseInt(form.quantity, 10) || 0,
        };
        if (placedTarget != null) {
          store.arm({ ...base, kind: 'TARGET', triggerPrice: placedTarget });
        }
        if (placedSl != null) {
          store.arm({ ...base, kind: 'STOP_LOSS', triggerPrice: placedSl });
        }
      }
      setSquareOffResult(null);
      setShowPreview(false);
      onOrderPlaced(result);
    } catch (err) {
      toast({ title: 'Order Failed', description: err instanceof Error ? err.message : 'Failed', variant: 'destructive' });
    } finally { setPlacing(false); }
  };

  const requestPlace = () => {
    if (!validation.valid) return;
    const confirm = settingsStore.getSettings().confirm;
    const sideConfirm = form.transactionType === 'BUY' ? confirm.confirmBuy : confirm.confirmSell;
    if (!isDemo || sideConfirm) {
      setShowPreview(true);
      return;
    }
    handlePlaceOrder();
  };

  const expectedPnl = useMemo(() => {
    const entry = needsLimitPrice(form.orderType) && parseFloat(form.price) > 0 ? parseFloat(form.price) : (quote?.ltp || 0);
    if (validation.target == null || !entry || !validation.qty) return null;
    if (form.transactionType === 'BUY') return (validation.target - entry) * validation.qty;
    return (entry - validation.target) * validation.qty;
  }, [validation, form.transactionType, form.orderType, form.price, quote?.ltp]);

  const targetPnlPct = useMemo(() => {
    if (expectedPnl == null || !validation.qty) return null;
    const entry = needsLimitPrice(form.orderType) && parseFloat(form.price) > 0 ? parseFloat(form.price) : (quote?.ltp || 0);
    const cost = entry * validation.qty;
    if (cost <= 0) return null;
    return (expectedPnl / cost) * 100;
  }, [expectedPnl, validation.qty, form.orderType, form.price, quote?.ltp]);

  const potentialSL = useMemo(() => {
    const entry = needsLimitPrice(form.orderType) && parseFloat(form.price) > 0 ? parseFloat(form.price) : (quote?.ltp || 0);
    if (validation.sl == null || !entry || !validation.qty) return null;
    if (form.transactionType === 'BUY') return (validation.sl - entry) * validation.qty;
    return (entry - validation.sl) * validation.qty;
  }, [validation, form.transactionType, form.orderType, form.price, quote?.ltp]);

  const isBUY = form.transactionType === 'BUY';
  const selectedOT = ORDER_TYPES.find(o => o.value === form.orderType);

  useEffect(() => {
    if (!quote?.ltp) return;
    const ltp = quote.ltp;
    let cancelled = false;
    evaluateTriggers((t) => (String(t.token) === String(stock.token) ? ltp : null))
      .then((outcomes) => {
        if (cancelled) return;
        for (const o of outcomes) {
          const reason: 'target' | 'sl' = o.kind === 'TARGET' ? 'target' : 'sl';
          setSquareOffResult({ reason, ok: o.ok, detail: o.detail });
          toast(
            o.ok
              ? {
                  title: reason === 'target' ? 'Target reached — squared off' : 'Stop loss hit — squared off',
                  description: `${stock.tradingSymbol || stock.symbol} · ${o.detail}`,
                }
              : {
                  title: 'Auto square-off failed',
                  description: o.detail,
                  variant: 'destructive' as const,
                },
          );
        }
      })
      .catch(() => { /* evaluation errors surface via markFailed */ });
    return () => { cancelled = true; };
  }, [quote?.ltp, stock.token, stock.tradingSymbol, stock.symbol, evaluateTriggers, toast]);

  const marginRefPrice = needsLimitPrice(form.orderType) && parseFloat(form.price) > 0
    ? parseFloat(form.price)
    : (quote?.ltp || 0);
  const marginPerUnit = marginRefPrice > 0 ? marginRefPrice * (form.product === 'MIS' ? 0.2 : 1) : null;

  const onExecuteClick = (side: 'BUY' | 'SELL') => {
    if (form.transactionType !== side) { updateForm({ transactionType: side }); return; }
    requestPlace();
  };

  const scrollToBasket = () => {
    basketRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const fe = validation.fieldErrors;

  const dirState: 'up' | 'down' | 'flat' | 'none' =
    !quote || !quote.ltp ? 'none' : quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat';

  const cardShell = cn(
    'rounded-2xl border shadow-soft overflow-hidden transition-colors',
    dirState === 'up' ? 'border-success/30 bg-success/[0.03]' :
    dirState === 'down' ? 'border-destructive/30 bg-destructive/[0.03]' :
    'border-border/60 bg-card',
  );
  const cardBar = cn(
    'h-1 w-full bg-gradient-to-r to-transparent',
    dirState === 'up' ? 'from-success/70 via-success/25' :
    dirState === 'down' ? 'from-destructive/70 via-destructive/25' :
    'from-info/70 via-primary/40',
  );
  const ltpColorClass =
    dirState === 'up' ? 'text-success' :
    dirState === 'down' ? 'text-destructive' :
    'text-foreground';
  const ltpGlow = cn(
    'transition-shadow',
    dirState === 'up' ? 'shadow-[0_10px_40px_-18px] shadow-success/40' :
    dirState === 'down' ? 'shadow-[0_10px_40px_-18px] shadow-destructive/40' :
    'shadow-none',
  );

  const targetStatusLabel = (() => {
    if (squareOffResult) {
      return squareOffResult.ok
        ? <span className="text-success font-semibold">Executed — square-off sent</span>
        : <span className="text-destructive font-semibold">Failed — close position manually</span>;
    }
    if (liveTrigger) return <span className="text-info">Armed @ {formatINR(liveTrigger.triggerPrice)} — monitored live</span>;
    if (lastTriggerOutcome) {
      return lastTriggerOutcome.status === 'FAILED'
        ? <span className="text-destructive">Square-off failed</span>
        : <span className="text-muted-foreground">Squared off before exit</span>;
    }
    return <span className="text-muted-foreground">Pending — arms after order placement</span>;
  })();

  return (
    <div className="w-full max-w-5xl mx-auto space-y-4 pb-6 animate-fade-in">
      {/* ═══════ SELECTED STOCK CARD ═══════ */}
      <section className={cardShell}>
        <div className={cardBar} />
        <div className="p-5 sm:p-6 space-y-4">
          {/* identity row */}
          <div className="flex items-start gap-3">
            <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back"
              className="h-10 w-10 p-0 shrink-0 rounded-xl hover:bg-muted/60">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{stock.tradingSymbol || stock.symbol}</h1>
                <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 h-5 border-info/30 text-info">{stock.exchangeSegment || stock.exchange}</Badge>
                <Badge variant="outline" className="text-[10px] font-mono px-1.5 py-0 h-5">EQ</Badge>
              </div>
              {stock.companyName && (
                <p className="text-xs sm:text-sm text-muted-foreground truncate mt-0.5">{stock.companyName}</p>
              )}
              <div className="flex items-center gap-2 mt-2">
                <Badge variant="outline" className={`text-[10px] px-2 py-0 h-5 ${getMarketStatusColor()}`}>
                  <CircleDot className="h-2.5 w-2.5 mr-1" />
                  {marketStatusText === 'Open' ? 'LIVE' : marketStatusText}
                </Badge>
                {!marketOpen && (
                  <Badge variant="outline" className="text-[10px] px-2 py-0 h-5 bg-warning/10 text-warning border-warning/30">
                    <Clock className="h-2.5 w-2.5 mr-1" /> AMO Enabled
                  </Badge>
                )}
              </div>
            </div>
            {/* Day change — explicit sign, direction from real change data */}
            <div className={`shrink-0 text-right ${quote && quote.ltp ? '' : 'opacity-60'}`}>
              {quote && quote.ltp ? (
                <>
                  <div className={`flex items-center justify-end gap-1 text-base font-bold font-mono tabular-nums ${
                    dirState === 'up' ? 'text-success' : dirState === 'down' ? 'text-destructive' : ''
                  }`}>
                    {dirState === 'up' ? <TrendingUp className="h-4 w-4" /> : dirState === 'down' ? <TrendingDown className="h-4 w-4" /> : null}
                    {signedINR(quote.change)}
                  </div>
                  <div className={`text-xs font-mono font-medium tabular-nums ${
                    dirState === 'up' ? 'text-success/80' : dirState === 'down' ? 'text-destructive/80' : 'text-muted-foreground'
                  }`}>{signedPct(quote.changePct)}</div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground font-mono">—</div>
              )}
            </div>
          </div>

          {/* LTP (large, live color) + Margin Price */}
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
            <div className={cn(
              'rounded-xl border p-4 sm:col-span-3 transition-colors',
              dirState === 'up' ? 'border-success/30 bg-success/[0.05]' :
              dirState === 'down' ? 'border-destructive/30 bg-destructive/[0.05]' :
              'border-border/40 bg-muted/20',
            )}>
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">LTP</div>
              {quoteLoading ? (
                <div className="h-10 w-32 bg-muted animate-pulse rounded-lg mt-1.5" />
              ) : quote?.ltp ? (
                <>
                  <div className={cn('mt-1.5 text-3xl sm:text-4xl font-bold font-mono tabular-nums tracking-tight leading-none', ltpColorClass, ltpGlow)}>
                    {formatINR(quote.ltp)}
                  </div>
                  <div className={cn('text-xs sm:text-sm font-mono font-semibold tabular-nums mt-2',
                    dirState === 'up' ? 'text-success' : dirState === 'down' ? 'text-destructive' : 'text-muted-foreground')}>
                    {signedINR(quote.change)} · {signedPct(quote.changePct)}
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className={cn('h-1.5 w-1.5 rounded-full', quote.status === 'LIVE' ? 'bg-success animate-pulse' : quote.status === 'STALE' ? 'bg-warning' : 'bg-destructive')} />
                    <span className="text-[10px] font-medium text-muted-foreground">{quote.status}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-1.5 text-3xl font-bold text-muted-foreground leading-none">—</div>
                  <div className="text-[10px] text-muted-foreground mt-2">no price feed</div>
                </>
              )}
            </div>
            <div className="rounded-xl border border-warning/25 bg-warning/[0.04] p-4 sm:col-span-2">
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Margin Price</div>
              {marginPerUnit != null ? (
                <>
                  <div className="mt-1.5 text-2xl sm:text-3xl font-semibold font-mono tabular-nums tracking-tight text-warning leading-none">
                    {formatINR(marginPerUnit)}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-2">per share · est. {form.product === 'MIS' ? '20% MIS margin' : 'full CNC value'}</div>
                </>
              ) : (
                <>
                  <div className="mt-1.5 text-2xl font-semibold text-muted-foreground leading-none">—</div>
                  <div className="text-[10px] text-muted-foreground mt-2">waiting for price feed</div>
                </>
              )}
            </div>
          </div>

          {!quoteLoading && !quote?.ltp && (
            <div className="flex items-center gap-2 text-xs font-normal text-warning">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              Market data unavailable
            </div>
          )}
        </div>

        {/* Stock Details — collapsed by default; bid/ask/volume/OHLC live here */}
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger asChild>
            <button className="w-full flex items-center justify-between px-5 sm:px-6 py-3 hover:bg-muted/30 transition-colors border-t border-border/30">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-info" />
                <span className="text-sm font-medium text-muted-foreground">Stock Details</span>
              </div>
              {detailsOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-5 sm:px-6 pb-4 space-y-4">
              <Separator />
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Bid / Ask</div>
                <div className="detail-metric-grid">
                  <DetailMetric label="Best Bid" value={quote?.bestBidPrice ? formatINR(quote.bestBidPrice) : '—'} sub={quote?.bestBidQty ? `×${formatCompact(quote.bestBidQty)}` : undefined} accent="text-success" />
                  <DetailMetric label="Best Ask" value={quote?.bestAskPrice ? formatINR(quote.bestAskPrice) : '—'} sub={quote?.bestAskQty ? `×${formatCompact(quote.bestAskQty)}` : undefined} accent="text-destructive" />
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Quote</div>
                <div className="detail-metric-grid">
                  <DetailMetric label="Volume" value={quote?.volume ? formatCompact(quote.volume) : '—'} />
                  <DetailMetric label="Open" value={quote?.open ? formatINR(quote.open) : '—'} />
                  <DetailMetric label="High" value={quote?.high ? formatINR(quote.high) : '—'} />
                  <DetailMetric label="Low" value={quote?.low ? formatINR(quote.low) : '—'} />
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Market Data</div>
                <div className="detail-metric-grid">
                  <DetailMetric label="Prev Close" value={quote?.prevClose ? formatINR(quote.prevClose) : '—'} />
                  <DetailMetric label="Avg Price" value={quote?.avgPrice ? formatINR(quote.avgPrice) : '—'} />
                  <DetailMetric label="Upper Circuit" value={quote?.upperCircuit ? formatINR(quote.upperCircuit) : '—'} accent="text-success" />
                  <DetailMetric label="Lower Circuit" value={quote?.lowerCircuit ? formatINR(quote.lowerCircuit) : '—'} accent="text-destructive" />
                  <DetailMetric label="Total Buy Qty" value={quote?.totalBuyQty ? formatCompact(quote.totalBuyQty) : '—'} />
                  <DetailMetric label="Total Sell Qty" value={quote?.totalSellQty ? formatCompact(quote.totalSellQty) : '—'} />
                </div>
              </div>
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Instrument</div>
                <div className="detail-metric-grid">
                  <DetailMetric label="Symbol" value={stock.symbol || '—'} />
                  <DetailMetric label="Trading Symbol" value={stock.tradingSymbol || '—'} />
                  <DetailMetric label="Token" value={stock.token || '—'} mono />
                  <DetailMetric label="Exchange" value={stock.exchangeSegment || stock.exchange || '—'} />
                  <DetailMetric label="Series" value={stock.series || '—'} />
                  <DetailMetric label="Type" value={stock.instrumentType || '—'} />
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* Existing position notice */}
      {position && position.netQty !== 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-warning/10 border border-warning/25 rounded-xl">
          <Info className="h-4 w-4 text-warning shrink-0" />
          <div className="text-xs min-w-0">
            <span className="font-semibold text-warning">Existing position · </span>
            <span className="font-mono tabular-nums text-foreground">
              {position.netQty > 0 ? 'LONG' : 'SHORT'} {Math.abs(position.netQty)} @ {formatINR(position.avgPrice)}
            </span>
            <span className={`ml-2 font-mono font-semibold ${position.unrealised >= 0 ? 'text-success' : 'text-destructive'}`}>
              P&L {formatINR(position.unrealised)}
            </span>
          </div>
        </div>
      )}

      {/* ═══════ ORDER FORM ═══════ */}
      <div ref={formRef} className="scroll-mt-4">
        <section className={cn('rounded-2xl border shadow-soft overflow-hidden', isBUY ? 'border-success/30' : 'border-destructive/30')}>
          <header className={cn('px-5 py-3.5 border-b border-border/30 flex items-center justify-between gap-3', isBUY ? 'bg-success/[0.05]' : 'bg-destructive/[0.05]')}>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Order Form</h2>
              <p className="text-[11px] font-normal text-muted-foreground truncate">
                {stock.tradingSymbol || stock.symbol} · {stock.exchangeSegment || stock.exchange}
              </p>
            </div>
            <span className={cn('inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[10px] font-semibold tracking-wider shrink-0',
              accountMode === 'api'
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-purple/40 bg-purple/10 text-purple')}>
              <span className={cn('h-1.5 w-1.5 rounded-full animate-pulse', accountMode === 'api' ? 'bg-success' : 'bg-purple')} />
              {accountMode === 'api' ? '● API MODE' : '● DEMO MODE'}
            </span>
          </header>

          <div className="p-5 space-y-4">
            {/* Single-column field stack — top to bottom */}
            <div className="space-y-4">
              <FormField id="oe-product" label="Product Type" icon={Layers} iconClass="text-purple" hint={PRODUCTS.find(p => p.value === form.product)?.detail}>
                <Select value={form.product} onValueChange={(v) => updateForm({ product: v })}>
                  <SelectTrigger id="oe-product" className="h-12 rounded-xl border-purple/30 bg-background text-sm font-medium focus:ring-purple/30">
                    <SelectValue placeholder="Select product" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRODUCTS.map(p => (
                      <SelectItem key={p.value} value={p.value} className="text-sm">
                        <span className="font-medium">{p.label}</span>
                        <span className="text-muted-foreground"> · {p.desc}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField id="oe-order-type" label="Order Type" icon={SlidersHorizontal} iconClass="text-info" hint={selectedOT?.desc}>
                <Select value={form.orderType} onValueChange={handleOrderTypeChange}>
                  <SelectTrigger id="oe-order-type" className="h-12 rounded-xl border-info/30 bg-background text-sm font-medium focus:ring-info/30">
                    <SelectValue placeholder="Select order type" />
                  </SelectTrigger>
                  <SelectContent>
                    {ORDER_TYPES.map(ot => (
                      <SelectItem key={ot.value} value={ot.value} className="text-sm">
                        <span className="font-medium">{ot.label}</span>
                        <span className="text-muted-foreground"> · {ot.desc}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>

              <FormField id="oe-quantity" label="Quantity" icon={Hash} iconClass="text-info" error={fe.quantity}>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline" size="sm" aria-label="Decrease quantity"
                    className="h-12 w-11 p-0 shrink-0 rounded-xl font-semibold"
                    onClick={() => updateForm({ quantity: String(Math.max(1, (parseInt(form.quantity) || 1) - 1)) })}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Input
                    id="oe-quantity"
                    type="number" min="1" step="1"
                    value={form.quantity}
                    onChange={(e) => updateForm({ quantity: e.target.value })}
                    className="h-12 text-center font-mono text-lg font-semibold rounded-xl border-info/30 focus-visible:ring-info/30 tabular-nums"
                  />
                  <Button
                    variant="outline" size="sm" aria-label="Increase quantity"
                    className="h-12 w-11 p-0 shrink-0 rounded-xl font-semibold"
                    onClick={() => updateForm({ quantity: String((parseInt(form.quantity) || 0) + 1) })}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </FormField>

              {needsLimitPrice(form.orderType) && (
                <FormField id="oe-limit-price" label="Limit Price" icon={IndianRupee} iconClass="text-purple" error={fe.limitPrice}>
                  <Input
                    id="oe-limit-price"
                    type="number" inputMode="decimal" step="0.05" min="0"
                    value={form.price === '0' ? '' : form.price}
                    onChange={(e) => updateForm({ price: e.target.value })}
                    className="h-12 font-mono text-lg rounded-xl border-purple/30 focus-visible:ring-purple/30 tabular-nums"
                    placeholder="0.00"
                  />
                  {quote?.ltp ? (
                    <button
                      className="mt-1.5 text-xs text-primary hover:text-primary/80 font-semibold flex items-center gap-1"
                      onClick={() => updateForm({ price: quote.ltp.toFixed(2) })}
                    >
                      <Zap className="h-3 w-3" /> Use LTP ({formatINR(quote.ltp)})
                    </button>
                  ) : null}
                </FormField>
              )}

              <FormField id="oe-sl-price" label="Stop Loss" icon={Shield} iconClass="text-destructive" hint="Optional — auto square-off level" error={fe.stopLoss}>
                <Input
                  id="oe-sl-price"
                  type="number" inputMode="decimal" step="0.05" min="0"
                  value={form.slPrice}
                  onChange={(e) => updateForm({ slPrice: e.target.value })}
                  className={cn('h-12 font-mono text-base rounded-xl border-destructive/25 focus-visible:ring-destructive/30 tabular-nums')}
                  placeholder="₹ Auto square-off level"
                />
              </FormField>

              <FormField id="oe-target-price" label="Target Price" icon={Target} iconClass="text-warning" hint="Optional — a real square-off order is auto-placed when LTP hits this price" error={fe.target}>
                <Input
                  id="oe-target-price"
                  type="number" inputMode="decimal" step="0.05" min="0"
                  value={form.targetPrice}
                  onChange={(e) => updateForm({ targetPrice: e.target.value })}
                  className="h-12 font-mono text-base rounded-xl border-warning/30 focus-visible:ring-warning/30 tabular-nums"
                  placeholder="₹ Exit trigger price"
                />
                {quote?.ltp && !fe.target && (
                  <button
                    className="mt-1.5 text-xs text-primary hover:text-primary/80 font-semibold flex items-center gap-1"
                    onClick={() => updateForm({ targetPrice: (isBUY ? quote.ltp * 1.01 : quote.ltp * 0.99).toFixed(2) })}
                  >
                    <Crosshair className="h-3 w-3" /> Suggest ±1% from LTP
                  </button>
                )}
              </FormField>

              {(form.slPrice.trim() !== '' || form.targetPrice.trim() !== '') && (
                <div className="bg-info/5 border border-info/25 rounded-lg px-3 py-2 flex items-start gap-2">
                  <Activity className="h-3.5 w-3.5 text-info shrink-0 mt-px" />
                  <p className="text-[11px] font-normal text-muted-foreground">
                    Bracket monitored live on this page while the position is open —
                    demo squares off automatically; live asks for confirmation first.
                  </p>
                </div>
              )}
            </div>

            {/* TOTAL AMOUNT + MARGIN REQUIRED — real-time as fields are typed */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <IndianRupee className="h-3.5 w-3.5 text-foreground/70" /> Total Amount
                </div>
                <div className="mt-1 text-2xl font-semibold font-mono tabular-nums tracking-tight text-foreground">
                  {validation.orderValue > 0 ? formatINR(validation.orderValue) : '—'}
                </div>
                <div className="mt-1.5 text-[11px] font-normal text-muted-foreground tabular-nums">
                  est. order value · {validation.qty > 0 ? validation.qty : 0} qty @ {validation.refPrice > 0 ? formatINR(validation.refPrice) : '—'}
                </div>
              </div>
              <div className="rounded-xl border border-warning/30 bg-warning/[0.04] p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[11px] font-semibold text-warning uppercase tracking-wider">
                    <Shield className="h-3.5 w-3.5" /> Margin Required
                  </div>
                  {validation.hasShortfall && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-destructive bg-destructive/10 border border-destructive/25 rounded-full px-2 py-0.5">
                      <AlertTriangle className="h-3 w-3" /> LOW FUNDS
                    </span>
                  )}
                </div>
                <div className={cn('mt-1 text-2xl font-semibold font-mono tabular-nums tracking-tight', validation.hasShortfall ? 'text-destructive' : 'text-warning')}>
                  {validation.requiredMargin > 0 ? formatINR(validation.requiredMargin) : '—'}
                </div>
                <div className="mt-1.5 flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11px] font-normal text-muted-foreground tabular-nums">
                  <span>Available <span className="font-medium text-foreground">{funds ? formatINR(funds.availableMargin) : '—'}</span></span>
                  <span>Remaining <span className={cn('font-medium', validation.hasShortfall ? 'text-destructive' : 'text-success')}>{funds ? formatINR(validation.remainingMargin) : '—'}</span></span>
                </div>
                {validation.hasShortfall && (
                  <div className="flex items-center gap-2 mt-2 text-xs font-medium text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Insufficient margin — {formatINR(Math.abs(validation.remainingMargin))} short
                  </div>
                )}
              </div>
            </div>

            {/* TARGET POSITION P&L — amber accent, when target set */}
            {validation.target != null && (
              <div className="rounded-xl border border-warning/30 bg-gradient-to-br from-warning/[0.06] to-transparent p-4 ring-1 ring-inset ring-warning/10">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 text-[11px] font-semibold text-warning uppercase tracking-wider">
                    <Target className="h-3.5 w-3.5" /> Target Position P&L
                  </div>
                  <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0 h-4 border-warning/40 text-warning">APP-MONITORED</Badge>
                </div>
                <div className="mt-2.5 space-y-1.5">
                  <DetailRow label="Target Price" value={formatINR(validation.target)} small strong />
                  <DetailRow
                    label="Expected P&L at Target"
                    value={expectedPnl != null ? signedINR(expectedPnl) : '—'}
                    small
                    className={expectedPnl != null ? (expectedPnl >= 0 ? 'text-success' : 'text-destructive') : ''}
                  />
                  <DetailRow
                    label="P&L % from Entry"
                    value={targetPnlPct != null ? signedPct(targetPnlPct) : '—'}
                    small
                    className={targetPnlPct != null ? (targetPnlPct >= 0 ? 'text-success' : 'text-destructive') : ''}
                  />
                  <DetailRow label="Square-off Quantity" value={`${validation.qty}`} small />
                  <DetailRow label="Status" value={targetStatusLabel} small />
                </div>
                <div className="mt-2.5 flex items-start gap-2 bg-info/5 border border-info/25 rounded-lg px-3 py-2">
                  <Zap className="h-3.5 w-3.5 text-info shrink-0 mt-px" />
                  <p className="text-[11px] font-normal text-muted-foreground leading-relaxed">
                    Auto square-off — when LTP reaches {formatINR(validation.target)}, the order is auto-placed to
                    square off all {validation.qty} qty at the best available price.
                  </p>
                </div>
              </div>
            )}

            {/* CHARGES BREAKDOWN — clickable, expands */}
            <Collapsible open={chargesOpen} onOpenChange={setChargesOpen}>
              <div className={cn('rounded-xl border overflow-hidden', chargesOpen ? 'border-warning/30' : 'border-border/40')}>
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                    <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <Coins className="h-4 w-4 text-warning" />
                      Charges Breakdown
                      <span className="text-[10px] font-mono text-muted-foreground/70 tabular-nums">
                        {validation.charges.total > 0 ? `≈ ${formatINR(validation.charges.total)}` : ''}
                      </span>
                    </span>
                    {chargesOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-4 pb-4 pt-1 space-y-2">
                    <Separator />
                    <div className="space-y-1.5">
                      <DetailRow label="Brokerage" value={formatINR(validation.charges.brokerage)} small />
                      <p className="text-[10px] font-normal text-muted-foreground/70 -mt-1.5 pl-0">Configurable in Settings</p>
                      <DetailRow label="STT" value={formatINR(validation.charges.stt)} small />
                      <DetailRow label="Exchange Transaction Charges" value={formatINR(validation.charges.exchangeTxn)} small />
                      <DetailRow label="GST" value={formatINR(validation.charges.gst)} small />
                      <DetailRow label="SEBI Charges" value={formatINR(validation.charges.sebi)} small />
                      <DetailRow label="Stamp Duty" value={formatINR(validation.charges.stampDuty)} small />
                    </div>
                    <Separator />
                    <DetailRow label="Total Charges" value={validation.charges.total > 0 ? formatINR(validation.charges.total) : '—'} small strong />
                    <p className="text-[10px] font-normal text-muted-foreground/70 leading-relaxed">
                      Estimates computed from the configured rate tables — final charges are confirmed by the broker on execution.
                    </p>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* ADVANCED OPTIONS — keeps routing + exit-order details */}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <div className="rounded-xl border border-border/40 overflow-hidden">
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors">
                    <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <SlidersHorizontal className="h-4 w-4 text-info" />
                      Advanced Options
                    </span>
                    {advancedOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-4 pb-4 pt-1 space-y-4">
                    <Separator />

                    {/* ORDER SUMMARY */}
                    <div>
                      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Order</div>
                      <div className="space-y-1.5">
                        <DetailRow label="Symbol" value={stock.tradingSymbol || stock.symbol} strong />
                        <DetailRow label="Exchange" value={stock.exchangeSegment || stock.exchange} small />
                        <DetailRow label="Side" value={
                          <span className={isBUY ? 'text-success font-semibold' : 'text-destructive font-semibold'}>{form.transactionType}</span>
                        } small />
                        <DetailRow label="Product" value={`${form.product} · ${form.product === 'MIS' ? 'Intraday' : 'Delivery'}`} small />
                        <DetailRow label="Order Type" value={selectedOT?.label || form.orderType} small />
                        <DetailRow label="Quantity" value={form.quantity} small />
                        <DetailRow label="Order Price" value={needsLimitPrice(form.orderType) ? (parseFloat(form.price) > 0 ? formatINR(parseFloat(form.price)) : '—') : 'Market (best available)'} small />
                        <DetailRow label="LTP" value={quote?.ltp ? formatINR(quote.ltp) : '—'} small />
                        <DetailRow label="Margin Price" value={marginPerUnit != null ? `${formatINR(marginPerUnit)} / share` : '—'} small />
                        <DetailRow label="Order Value" value={validation.orderValue > 0 ? formatINR(validation.orderValue) : '—'} small />
                        <DetailRow label="Required Margin" value={validation.requiredMargin > 0 ? formatINR(validation.requiredMargin) : '—'} small strong />
                      </div>
                    </div>

                    <Separator />

                    {/* TARGET / EXIT ORDER CHARGES — kept separate from current charges */}
                    {validation.exitCharges && validation.target != null && (
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-warning">
                            <Coins className="h-3.5 w-3.5" /> Target / Exit Order Charges
                          </span>
                          <Badge variant="outline" className="text-[9px] font-semibold px-1.5 py-0 h-4 border-warning/30 text-warning">ESTIMATE</Badge>
                        </div>
                        <div className="space-y-1.5">
                          <DetailRow label="Exit Leg" value={`${validation.exitSide} · ${form.product}`} small />
                          <DetailRow label="Target Position Price" value={formatINR(validation.target)} small />
                          <DetailRow label="Target Quantity" value={`${validation.qty}`} small />
                          <DetailRow label="Expected Exit Value" value={validation.qty > 0 ? formatINR(validation.qty * validation.target) : '—'} small />
                          <DetailRow label="Target Order Status" value={targetStatusLabel} small />
                          <div className="pt-1.5 space-y-1.5">
                            <ChargeRows c={validation.exitCharges} estimated />
                          </div>
                        </div>
                      </div>
                    )}

                    {(validation.sl != null || validation.target != null) && potentialSL !== null && (
                      <DetailRow
                        label="Max Loss at Stop Loss"
                        value={formatINR(potentialSL)}
                        className="text-destructive"
                        small
                      />
                    )}

                    <Separator />
                    <DetailRow label="Total Estimated Charges (entry + exit)" value={validation.totalEstimatedCharges > 0 ? formatINR(validation.totalEstimatedCharges) : '—'} strong />

                    {/* Advanced routing options */}
                    <Separator />
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <Label className="text-[11px] font-semibold text-muted-foreground">Validity</Label>
                        <div className="flex gap-1.5 mt-2">
                          {['DAY', 'IOC'].map(v => (
                            <button key={v} className={cn('flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all border', form.validity === v ? 'bg-muted border-border text-foreground' : 'border-border/40 text-muted-foreground hover:bg-muted/50')} onClick={() => updateForm({ validity: v })}>{v}</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label className="text-[11px] font-semibold text-muted-foreground">Disclosed Qty</Label>
                        <Input type="number" min="0" value={form.disclosedQty} onChange={(e) => updateForm({ disclosedQty: e.target.value })} className="h-10 mt-2 font-mono text-sm rounded-lg" />
                      </div>
                      <div>
                        <Label className="text-[11px] font-semibold text-muted-foreground">AMO</Label>
                        <div className="flex gap-1.5 mt-2">
                          {['NO', 'YES'].map(v => (
                            <button key={v} className={cn('flex-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all border', form.amo === v ? 'bg-muted border-border text-foreground' : 'border-border/40 text-muted-foreground hover:bg-muted/50')} onClick={() => updateForm({ amo: v })}>{v === 'YES' ? 'AMO' : 'Regular'}</button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label className="text-[11px] font-semibold text-muted-foreground">Exchange</Label>
                        <div className="h-10 mt-2 flex items-center px-3 bg-muted/40 rounded-lg text-sm font-mono">{stock.exchangeSegment || stock.exchange}</div>
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            {/* Basket Panel */}
            <div ref={basketRef} className="scroll-mt-4">
              <BasketOrderPanel
                symbol={stock.symbol}
                exchange={stock.exchange}
                token={stock.token}
                transactionType={form.transactionType}
                product={form.product}
                orderType={form.orderType}
                quantity={form.quantity}
                price={form.price}
              />
            </div>

            {/* Armed auto square-off status (persistent trigger registry) */}
            {liveTrigger && (
              <div className="bg-info/5 border border-info/25 rounded-lg p-2.5 flex items-start gap-2">
                <Activity className="h-4 w-4 text-info shrink-0 mt-0.5" />
                <div className="text-xs min-w-0">
                  <div className="font-semibold text-info">
                    Auto square-off armed · {liveTrigger.kind === 'TARGET' ? 'Target' : 'Stop loss'}
                  </div>
                  <div className="text-muted-foreground mt-0.5 tabular-nums">
                    {liveTrigger.quantity} qty {liveTrigger.side} ·
                    {' '}{liveTrigger.kind === 'TARGET' ? 'T' : 'SL'} {formatINR(liveTrigger.triggerPrice)}
                    {' '}· LTP {quote?.ltp ? formatINR(quote.ltp) : '—'}
                  </div>
                </div>
                <button className="ml-auto text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
                  onClick={() => getTriggerStore().cancel(liveTrigger.id)}>
                  Cancel
                </button>
              </div>
            )}

            {/* Real square-off outcome */}
            {squareOffResult && !liveTrigger && (
              <div className={cn('rounded-lg p-2.5 flex items-start gap-2 border', squareOffResult.ok ? 'bg-success/5 border-success/25' : 'bg-destructive/5 border-destructive/25')}>
                {squareOffResult.ok ? <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />}
                <div className="text-xs min-w-0">
                  <div className={cn('font-semibold', squareOffResult.ok ? 'text-success' : 'text-destructive')}>
                    {squareOffResult.reason === 'target' ? 'Target square-off executed' : 'Stop-loss square-off executed'}
                  </div>
                  <div className="text-muted-foreground mt-0.5">{squareOffResult.detail}</div>
                </div>
              </div>
            )}
          </div>

          {/* FINAL BUY / SELL EXECUTION CONTROL — at the very end of the form */}
          <div className="border-t border-border/30 bg-muted/20 p-4 space-y-2">
            <div className="grid grid-cols-2 gap-2 p-1.5 rounded-2xl bg-background border border-border/40 shadow-inner">
              <button
                disabled={placing || !validation.valid || quoteLoading || !quote?.ltp}
                onClick={() => onExecuteClick('BUY')}
                className={cn('h-12 sm:h-14 rounded-xl text-base font-semibold transition-all flex items-center justify-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed',
                  isBUY
                    ? 'bg-success text-success-foreground shadow-lg shadow-success/30 ring-1 ring-success/40'
                    : 'text-success hover:bg-success/10')}
              >
                {placing && isBUY ? (
                  <><Loader2 className="h-5 w-5 animate-spin" /> Placing…</>
                ) : (
                  <><TrendingUp className="h-5 w-5" /> BUY{isBUY && quote?.ltp ? <span className="text-sm font-mono opacity-75">{formatINR(quote.ltp)}</span> : null}</>
                )}
              </button>
              <button
                disabled={placing || !validation.valid || quoteLoading || !quote?.ltp}
                onClick={() => onExecuteClick('SELL')}
                className={cn('h-12 sm:h-14 rounded-xl text-base font-semibold transition-all flex items-center justify-center gap-2.5 disabled:opacity-50 disabled:cursor-not-allowed',
                  !isBUY
                    ? 'bg-destructive text-destructive-foreground shadow-lg shadow-destructive/30 ring-1 ring-destructive/40'
                    : 'text-destructive hover:bg-destructive/10')}
              >
                {placing && !isBUY ? (
                  <><Loader2 className="h-5 w-5 animate-spin" /> Placing…</>
                ) : (
                  <><TrendingDown className="h-5 w-5" /> SELL{!isBUY && quote?.ltp ? <span className="text-sm font-mono opacity-75">{formatINR(quote.ltp)}</span> : null}</>
                )}
              </button>
            </div>
            <p className="text-[11px] font-normal text-muted-foreground text-center flex items-center justify-center gap-1.5">
              <Info className="h-3 w-3 shrink-0" />
              Tap the selected side again to review &amp; place · every live order requires review
            </p>

            {/* Secondary Add to Basket action */}
            <Button
              variant="outline"
              className="w-full h-11 rounded-xl text-sm font-semibold border-purple/30 text-purple hover:text-purple hover:bg-purple/5"
              onClick={scrollToBasket}
            >
              <Package className="h-4 w-4 mr-1.5" />
              Add to Basket
            </Button>
          </div>
        </section>
      </div>

      {/* ═══════ PREVIEW MODAL ═══════ */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowPreview(false)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto animate-in fade-in-0 zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 pb-0 flex items-center justify-between">
              <h3 className="text-lg font-semibold">Review Order</h3>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-lg" onClick={() => setShowPreview(false)}>✕</Button>
            </div>

            <div className="p-5 space-y-4">
              <div className={cn('rounded-xl p-4', isBUY ? 'bg-success/10 border border-success/20' : 'bg-destructive/10 border border-destructive/20')}>
                <div className={cn('font-semibold text-xl', isBUY ? 'text-success' : 'text-destructive')}>
                  {form.transactionType} {stock.tradingSymbol || stock.symbol}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {stock.exchangeSegment || stock.exchange} • {form.product} • {selectedOT?.label}{form.amo === 'YES' ? ' • AMO' : ''}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <PreviewItem label="Quantity" value={form.quantity} />
                {needsLimitPrice(form.orderType)
                  ? <PreviewItem label="Limit Price" value={parseFloat(form.price) > 0 ? formatINR(parseFloat(form.price)) : '—'} />
                  : <PreviewItem label="Execution" value="Market (best available)" />}
                {quote?.ltp ? <PreviewItem label="LTP" value={formatINR(quote.ltp)} /> : null}
                <PreviewItem label="Total Amount" value={formatINR(validation.orderValue)} className="font-semibold" />
                <PreviewItem label="Margin Required" value={validation.requiredMargin > 0 ? formatINR(validation.requiredMargin) : '—'} />
                <PreviewItem label="Charges" value={formatINR(validation.charges.total)} />
                {validation.target != null && <PreviewItem label="Target (monitored)" value={formatINR(validation.target)} className="text-success" />}
                {validation.sl != null && <PreviewItem label="Stop Loss (monitored)" value={formatINR(validation.sl)} className="text-destructive" />}
                {expectedPnl != null && (
                  <PreviewItem label="Expected P&L at Target" value={signedINR(expectedPnl)} className={expectedPnl >= 0 ? 'text-success' : 'text-destructive'} />
                )}
                {targetPnlPct != null && (
                  <PreviewItem label="P&L % from Entry" value={signedPct(targetPnlPct)} className={targetPnlPct >= 0 ? 'text-success' : 'text-destructive'} />
                )}
              </div>

              {validation.target != null && (
                <div className="bg-info/5 border border-info/20 rounded-xl p-3 text-xs text-info flex items-start gap-2">
                  <Zap className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>On hitting {formatINR(validation.target)}, the target square-off order is auto-placed for {validation.qty} qty.</span>
                </div>
              )}

              <div className="bg-warning/10 border border-warning/20 rounded-xl p-3 text-xs text-warning flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>This order will be sent to the exchange. Please confirm.</span>
              </div>

              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 h-12 text-sm rounded-xl font-semibold" onClick={() => setShowPreview(false)} disabled={placing}>Back</Button>
                <Button
                  className={cn('flex-1 h-12 font-semibold text-sm rounded-xl', isBUY ? 'bg-success hover:bg-success/90 text-success-foreground shadow-lg shadow-success/20' : 'bg-destructive hover:bg-destructive/90 text-destructive-foreground shadow-lg shadow-destructive/20')}
                  onClick={handlePlaceOrder}
                  disabled={placing || !validation.valid}
                >
                  {placing ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Placing...</> : <>Confirm & {form.transactionType}</>}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════ SUB-COMPONENTS ═══════ */

function DetailMetric({ label, value, sub, mono, accent }: { label: string; value: string; sub?: string; mono?: boolean; accent?: string }) {
  return (
    <div className="detail-metric">
      <div className="detail-metric-label">{label}</div>
      <div className={cn('detail-metric-value', mono ? 'font-mono' : '', accent || '')}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground/60 font-mono">{sub}</div>}
    </div>
  );
}

/** Vertical stacked form field — label above the control */
function FormField({ id, label, icon: Icon, iconClass, hint, error, children }: {
  id?: string;
  label: string;
  icon: React.ElementType;
  iconClass?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground cursor-pointer">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', iconClass)} />
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[11px] font-normal text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function ChargeRows({ c, estimated }: { c: { brokerage: number; stt: number; exchangeTxn: number; gst: number; sebi: number; stampDuty: number; total: number }; estimated?: boolean }) {
  return (
    <>
      <DetailRow label="Brokerage" value={formatINR(c.brokerage)} small />
      <DetailRow label="Exchange Charges" value={formatINR(c.exchangeTxn)} small />
      <DetailRow label="STT" value={formatINR(c.stt)} small />
      <DetailRow label="GST" value={formatINR(c.gst)} small />
      <DetailRow label="SEBI Charges" value={formatINR(c.sebi)} small />
      <DetailRow label="Stamp Duty" value={formatINR(c.stampDuty)} small />
      <DetailRow label={estimated ? 'Total Estimated Charges' : 'Total Charges'} value={c.total > 0 ? formatINR(c.total) : '—'} small strong />
    </>
  );
}

function DetailRow({ label, value, strong, small, className }: {
  label: string; value: React.ReactNode; strong?: boolean; small?: boolean; className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', small ? 'text-xs' : 'text-sm')}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('text-right font-mono tabular-nums', strong ? 'font-semibold' : '', className || '')}>{value}</span>
    </div>
  );
}

function PreviewItem({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground font-medium">{label}</div>
      <div className={cn('font-semibold font-mono', className || '')}>{value}</div>
    </div>
  );
}