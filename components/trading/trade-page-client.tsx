'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { 
  Search, X, Loader2, Shield, Receipt, Target, Boxes, 
  ArrowLeftRight, ChevronRight, TrendingUp, TrendingDown,
  Activity, Info, AlertCircle, Check
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  getSettingsStore, 
  useTradingMode,
  type TradingMode 
} from '@/lib/settings-store';
import { 
  getTerminalMargin, 
  getTerminalPositions, 
  placeTerminalOrder, 
  riskPrecheck, 
  toTerminalId, 
  isAuthenticated, 
  ensureTerminalAuth,
  getTerminalQuote,
} from '@/lib/terminal-service';
import { TradingService } from '@/lib/trading-service';
import { getDemoPositions, getMarketWatchTickSnapshot, placeDemoOrder } from '@/lib/api';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { dedupFetch } from '@/lib/request-dedup';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { useRealtime } from '@/components/realtime-provider';
import { useSystem } from '@/components/system-provider';
import { useInstrumentTick } from '@/hooks/use-instrument-tick';
import { useOnDemandQuote } from '@/hooks/use-on-demand-quote';
import { capsFor, SIDE_CLASS } from '@/components/orders/trade/capabilities';
import { useTouchPointer } from '@/hooks/use-media-query';
import { useTriggers } from '@/lib/trigger-store';
import { marginPerShare, quantityFromMargin } from '@/lib/order-workspace';
import { setBasketDraft } from '@/lib/basket-draft';
import { useEngines } from '@/lib/engine-realtime';
import type { RealtimeChannelSpec } from '@/lib/realtime-ws';
import type { 
  ExecState, 
  InstrumentSelection, 
  LiveQuote, 
  PrecheckSummary, 
  TicketState 
} from '@/components/orders/trade/types';
import { SafeRegion } from './safe-region';
import { SelectedStockCard } from './selected-stock-card';
import { OrderTicket } from './order-ticket';
import { RiskMarginPanel } from './risk-margin-panel';
import { ChargesPanel } from './charges-panel';
import { TargetPanel } from './target-panel';
import { ExecutionState } from './execution-state';
import { SlideToOrder } from './slide-to-order';
import { AuthGate } from './auth-gate';
import { InsightSheet, type InsightSection } from './insight-sheet';
import { InstrumentSearch } from './instrument-search';
import { StatusBadge, pnlTone } from '@/components/design-system';

const FILLED_STATUSES = new Set(['COMPLETE', 'COMPLETED', 'FILLED', 'EXECUTED']);
const EMPTY_EXEC: ExecState = { phase: 'idle' };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

function sanitizeSelection(sel: InstrumentSelection): InstrumentSelection {
  return {
    symbol: str(sel.symbol || sel.tradingSymbol),
    token: sel.token != null ? String(sel.token) : '',
    exchange: str(sel.exchange, 'NSE'),
    exchangeSegment: sel.exchangeSegment ? str(sel.exchangeSegment) : undefined,
    tradingSymbol: sel.tradingSymbol ? str(sel.tradingSymbol) : undefined,
    companyName: sel.companyName ? str(sel.companyName) : undefined,
    isin: sel.isin ? str(sel.isin) : undefined,
    instrumentType: sel.instrumentType ? str(sel.instrumentType) : undefined,
    lotSize: num(sel.lotSize) ?? undefined,
    tickSize: num(sel.tickSize) ?? undefined,
    ltp: num(sel.ltp),
    prevClose: num(sel.prevClose),
    change: num(sel.change),
    changePct: num(sel.changePct),
    upperCircuit: num(sel.upperCircuit),
    lowerCircuit: num(sel.lowerCircuit),
    oneQtyMargin: num(sel.oneQtyMargin),
    marginStatus: sel.marginStatus ? str(sel.marginStatus) : undefined,
    liveStatus: sel.liveStatus ? str(sel.liveStatus) : undefined,
    tickAgeSeconds: num(sel.tickAgeSeconds),
  };
}

function stringifyDetail(d: unknown): string {
  if (typeof d === 'string' && d) return d;
  if (d == null) return 'unknown error';
  try { return JSON.stringify(d); } catch { return String(d); }
}

function bucketLtp(ltp: number | null | undefined): number | null {
  const n = Number(ltp);
  if (!Number.isFinite(n) || n <= 0) return null;
  const step = Math.max(0.01, Math.round(n * 0.0025 * 100) / 100);
  return Math.round(n / step) * step;
}

function normalizePosition(o: Record<string, any>) {
  return {
    symbol: str(o.symbol ?? o.tradingSymbol ?? o.sym ?? o.scripname ?? '?'),
    netQty: num(o.netQuantity ?? o.netQty ?? o.net_quantity ?? o.qty),
    avg: num(o.netAveragePrice ?? o.averagePrice ?? o.averageBuyPrice ?? o.avg_price),
    ltp: num(o.ltp ?? o.lastPrice),
    pnl: num(o.unrealizedPnl ?? o.unrealisedPnl ?? o.unrealised ?? o.pnl),
  };
}

export function TradePageClient() {
  const mode = useTradingMode();
  const terminal = toTerminalId(mode);
  const caps = useMemo(() => capsFor(terminal), [terminal]);
  const isDemo = mode === 'dummy';
  const unit = caps.virtualCurrency ? 'C' : '₹';

  // State
  const [selection, setSelectionRaw] = useState<InstrumentSelection | null>(null);
  const [circuitSnap, setCircuitSnap] = useState<Record<string, any> | null>(null);
  const [seedQuote, setSeedQuote] = useState<InstrumentSelection | null>(null);
  const [ticket, setTicket] = useState<TicketState>(() => ({
    side: 'BUY', product: 'MIS', orderType: 'MKT', quantity: '1',
    price: '0', triggerPrice: '', validity: 'DAY', targetPrice: '', slPrice: '',
  }));
  const [checking, setChecking] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const [precheck, setPrecheck] = useState<PrecheckSummary>({
    kind: 'UNKNOWN', label: 'Build an order to receive a risk verdict.', 
    reasons: [], checks: {}, marginAvailable: null, marginMessage: null, 
    marginRequired: null, checkedAt: null,
  });
  const [exec, setExec] = useState<ExecState>(EMPTY_EXEC);
  const [execId, setExecId] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [chargesPreview, setChargesPreview] = useState<{ 
    charges: Record<string, any> | null; 
    total: number | null; 
    marginRequired: number | null; 
    freeMargin: number | null; 
    after: number | null; 
    sufficient: boolean | null 
  } | null>(null);
  const [realtimeOrder, setRealtimeOrder] = useState<Record<string, any> | null>(null);
  const [rtPos, setRtPos] = useState<{ symbol: string; position: Record<string, any> | null } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [positions, setPositions] = useState<Record<string, any>[] | null>(null);
  const [funds, setFunds] = useState<{ availableMargin: number; usedMargin: number } | null>(null);
  const [basketName, setBasketName] = useState('My Basket');
  const [basketItems, setBasketItems] = useState<Array<{ id: string; selection: InstrumentSelection; ticket: TicketState; addedAt: number }>>([]);
  const [dataStatus, setDataStatus] = useState<'OFFLINE' | 'WAITING' | 'LIVE' | 'STALE'>('WAITING');
  const [mountTime] = useState(Date.now());

  const symbol = selection?.symbol;
  const token = selection?.token != null ? String(selection.token) : '';
  const exchangeSegment = selection?.exchangeSegment || selection?.exchange || '';

  const setSelection = useCallback((sel: InstrumentSelection | null) => {
    setSelectionRaw(sel ? sanitizeSelection(sel) : null);
  }, []);

  const realtime = useFrontendRealtime();
  const rt = useRealtime();
  const systemMarket = useSystem().market;
  const allTriggers = useTriggers();
  const { engines, connected: enginesConnected } = useEngines();

  // Session auth
  useEffect(() => {
    if (isDemo) { setLoggedIn(true); setAuthResolved(true); return; }
    let cancelled = false;
    ensureTerminalAuth().then((ok) => {
      if (cancelled) return;
      if (ok) setLoggedIn(true);
      setAuthResolved(true);
    });
    return () => { cancelled = true; };
  }, [isDemo]);

  const session = useMemo(() => ({ active: loggedIn || isDemo }), [loggedIn, isDemo]);

  // Feed subscription
  useEffect(() => {
    if (!selection) return;
    const segment = exchangeSegment.toLowerCase();
    const tok = String(selection.token || '');
    if (!tok) return;
    const spec: RealtimeChannelSpec = {
      channel: 'trading',
      instruments: [{ exchange_segment: segment, instrument_token: tok, symbol: selection.symbol }],
    };
    realtime.subscribe([spec]).catch(() => {});
    realtime.requestSnapshot().catch(() => {});
    return () => {
      realtime.unsubscribe([{ channel: 'trading', instruments: [{ exchange_segment: segment, instrument_token: tok }] }]).catch(() => {});
    };
  }, [token, symbol, exchangeSegment, realtime]);

  // Live tick
  const liveTickIdentity = useMemo(() => (selection ? { token: selection.token, symbol: selection.symbol } : null), [token, symbol]);
  const liveTick = useInstrumentTick(liveTickIdentity, !!selection);

  // On-demand quote
  const streamHasTick = liveTick.quote?.ltp != null;
  const onDemandIdentity = useMemo(() => (selection ? { token: selection.token, symbol: selection.symbol, exchange: exchangeSegment } : null), [token, symbol, exchangeSegment]);
  const { quote: onDemandQuote } = useOnDemandQuote(onDemandIdentity, !!selection, streamHasTick);

  // Order + position lifecycle
  useEffect(() => {
    const stateChannels: RealtimeChannelSpec[] = [{ channel: 'orders' }, { channel: 'positions' }];
    realtime.subscribe(stateChannels).catch(() => {});
    return () => { realtime.unsubscribe(stateChannels).catch(() => {}); };
  }, [realtime]);

  // Patch from realtime frames
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    const off = realtime.onFrame((frame) => {
      const sel = selectionRef.current;
      if (!sel) return;
      const payload = (frame.data as Record<string, any> | undefined)?.data;
      if (!payload || typeof payload !== 'object') return;
      const sym = sel.symbol.toUpperCase();
      if (frame.channel === 'orders' && frame.type === 'order.update') {
        const frameSymbol = String(payload.symbol ?? payload.order?.symbol ?? '').toUpperCase();
        if (frameSymbol && frameSymbol !== sym) return;
        setRealtimeOrder(payload);
        return;
      }
      if (frame.channel === 'positions' && frame.type === 'position.update') {
        const list = payload.positions;
        if (!Array.isArray(list)) return;
        const found = list.find(
          (p: Record<string, any>) => String(p.symbol ?? p.tradingSymbol ?? '').toUpperCase() === sym,
        ) ?? null;
        setRtPos({ symbol: sym, position: found });
      }
    });
    return off;
  }, [realtime.onFrame]);

  // Quote composition
  const quote = useMemo<LiveQuote | null>(() => {
    if (!selection || !token) return null;
    const segment = exchangeSegment.toLowerCase();
    let view = realtime.ticks.get(`${segment}|${token}`);
    if (!view) {
      for (const v of realtime.ticks.values()) {
        if (v.instrument_token === token) { view = v; break; }
      }
    }
    const stream = liveTick.quote?.ltp != null ? liveTick.quote : null;
    const viewTs = view?.receivedAt ? Date.parse(String(view.receivedAt)) : NaN;
    const viewFresh = Number.isFinite(viewTs) && Date.now() - viewTs < 120_000;
    const streamedView = view && viewFresh ? view : null;
    const rest = stream || streamedView ? null : onDemandQuote;
    const snap = stream || streamedView || rest?.ltp != null ? null : circuitSnap;
    const seed = stream || streamedView || rest?.ltp != null || snap?.ltp != null ? null : seedQuote;

    const prevClose = stream?.prevClose ?? (view ? num(view.prevClose) : null) ?? rest?.prevClose ?? num(snap?.prevClose) ?? seed?.prevClose ?? null;
    const ltp = stream?.ltp ?? num(view?.ltp) ?? rest?.ltp ?? num(snap?.ltp) ?? seed?.ltp ?? null;
    const change = stream?.change ?? (view?.netChange != null ? num(view.netChange) : null) ?? rest?.change ?? num(snap?.change) ?? seed?.change ?? (prevClose != null && ltp != null ? ltp - prevClose : null);
    const changePct = stream?.changePct ?? (view?.netChangePct != null ? num(view.netChangePct) : null) ?? rest?.changePct ?? num(snap?.changePercent) ?? seed?.changePct ?? (prevClose != null && prevClose !== 0 && change != null ? (change / prevClose) * 100 : null);
    const raw = (view?.raw ?? {}) as Record<string, any>;
    const upperCircuit = stream?.upperCircuit ?? num(raw.upper_circuit ?? raw.upperCircuit ?? raw.priceband_upper) ?? num(circuitSnap?.upperCircuit) ?? seed?.upperCircuit ?? null;
    const lowerCircuit = stream?.lowerCircuit ?? num(raw.lower_circuit ?? raw.lowerCircuit ?? raw.priceband_lower) ?? num(circuitSnap?.lowerCircuit) ?? seed?.lowerCircuit ?? null;
    if (ltp == null && upperCircuit == null && lowerCircuit == null) return null;
    const streamed = Boolean(stream || streamedView);
    const sourceLabel = stream ? 'live tick stream' : streamedView ? 'realtime trading channel' : rest?.ltp != null ? (rest.stale ? (rest.source === 'last_close' ? 'last stored close' : 'last trade (broker)') : 'broker quote (on demand)') : view ? 'channel snapshot (last tick)' : snap?.ltp != null ? 'market-watch snapshot' : 'search snapshot';
    return {
      ltp, open: stream?.open ?? num(view?.open) ?? num(circuitSnap?.open) ?? rest?.open ?? null,
      high: stream?.high ?? num(view?.high) ?? num(circuitSnap?.high) ?? rest?.high ?? null,
      low: stream?.low ?? num(view?.low) ?? num(circuitSnap?.low) ?? rest?.low ?? null,
      close: prevClose, volume: stream?.volume ?? num(view?.volume) ?? num(circuitSnap?.volume) ?? null,
      change, changePct, upperCircuit: num(upperCircuit), lowerCircuit: num(lowerCircuit),
      source: sourceLabel, sourceId: stream ? 'websocket' : streamedView ? 'websocket' : rest?.ltp != null ? rest.source : view ? 'channel_snapshot' : snap?.ltp != null ? 'snapshot' : seed?.source ?? null,
      asOf: rest?.asOf ?? (view?.receivedAt ? String(view.receivedAt) : null) ?? seed?.asOf ?? null,
      ts: stream?.ts ?? rest?.fetchedAt ?? (view?.receivedAt ? Date.parse(String(view.receivedAt)) : Date.now()),
      stale: !streamed, raw,
    };
  }, [realtime.ticks, realtime.tickEpoch, liveTick.quote, onDemandQuote, token, symbol, exchangeSegment, circuitSnap, seedQuote]);

  // Data status
  const ltpNum = quote?.ltp != null ? num(quote.ltp) : null;
  useEffect(() => {
    const t = setInterval(() => {
      if (!realtime.connected && liveTick.quote == null) setDataStatus('OFFLINE');
      else if (ltpNum == null) setDataStatus('WAITING');
      else if (Date.now() - (quote?.ts ?? Date.now()) > 5000) setDataStatus('STALE');
      else setDataStatus('LIVE');
    }, 1000);
    return () => clearInterval(t);
  }, [realtime.connected, liveTick.quote, ltpNum, quote?.ts]);

  // Paper LTP
  useEffect(() => {
    if (!isDemo || !symbol || ltpNum == null || ltpNum <= 0) return;
    feedDummyLtp(symbol, ltpNum);
  }, [isDemo, symbol, ltpNum]);

  // Margin sizing
  const lotSizeNum = useMemo(() => { const l = num(selection?.lotSize); return l != null && l >= 1 ? Math.round(l) : 1; }, [selection?.lotSize]);
  const amountMargin = num(ticket.amount) != null && (num(ticket.amount) as number) > 0 ? (num(ticket.amount) as number) : 0;
  const seedLtp = num(selection?.ltp) != null && (num(selection?.ltp) as number) > 0 ? (num(selection?.ltp) as number) : null;
  const effLtp = ltpNum ?? seedLtp;
  const marginPerShareVal = marginPerShare({ price: (ticket.orderType === 'L' || ticket.orderType === 'SL') ? num(ticket.price) : effLtp, product: ticket.product, oneQtyMargin: selection?.oneQtyMargin }) ?? 0;

  // Risk key
  const riskKey = [
    token, symbol, selection?.exchange, ticket.side, ticket.product, ticket.orderType,
    ticket.quantity, (ticket.orderType === 'L' || ticket.orderType === 'SL') ? ticket.price : '', 
    (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? ticket.triggerPrice : '',
    bucketLtp(ltpNum) ?? '', loggedIn ? '1' : '0', authResolved ? 'r' : 'p', terminal,
  ].join('|');

  // Risk precheck
  useEffect(() => {
    if (!selection) { setPrecheck({ kind: 'UNKNOWN', label: 'Search and select an instrument to begin.', reasons: [], checks: {}, checkedAt: null }); setChecking(false); return; }
    if (!loggedIn && !isDemo) { setPrecheck(authResolved ? { kind: 'EMERGENCY_BLOCK', label: 'Sign in to unlock trading actions.', reasons: [], checks: {}, checkedAt: null } : { kind: 'UNKNOWN', label: 'Connecting trading session…', reasons: [], checks: {}, checkedAt: null }); setChecking(false); return; }
    if (!(ticket.orderType === 'L' || ticket.orderType === 'SL') && effLtp == null) { setPrecheck({ kind: 'UNKNOWN', label: 'Waiting for the market price…', reasons: [], checks: {}, checkedAt: null }); setChecking(false); return; }
    const qty = Number(ticket.quantity);
    if (!Number.isInteger(qty) || qty < 1) { setPrecheck({ kind: 'UNKNOWN', label: 'Enter a whole-number quantity of at least 1.', reasons: [], checks: {}, checkedAt: null }); setChecking(false); return; }
    const priceNum = (ticket.orderType === 'L' || ticket.orderType === 'SL') ? Number(ticket.price) : 0;
    const triggerNum = (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? Number(ticket.triggerPrice) : 0;
    if ((ticket.orderType === 'L' || ticket.orderType === 'SL') && !(priceNum > 0)) { setPrecheck({ kind: 'UNKNOWN', label: 'Limit / SL orders need a positive limit price.', reasons: [], checks: {}, checkedAt: null }); setChecking(false); return; }
    if ((ticket.orderType === 'SL' || ticket.orderType === 'SL-M') && !(triggerNum > 0)) { setPrecheck({ kind: 'UNKNOWN', label: 'Stop orders need a positive trigger price.', reasons: [], checks: {}, checkedAt: null }); setChecking(false); return; }

    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const risk = await riskPrecheck({
          terminal, symbol: selection.symbol, token: selection.token, exchange: selection.exchange,
          transaction_type: ticket.side, product: ticket.product, order_type: ticket.orderType,
          quantity: String(qty), price: (ticket.orderType === 'L' || ticket.orderType === 'SL') ? String(priceNum) : '0',
          trigger_price: (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? String(triggerNum) : '0',
          expected_ltp: bucketLtp(ltpNum) ?? 0,
        });
        let margin: Record<string, any> | null = null;
        if (caps.supportsMarginPreview) {
          try {
            const m = await getTerminalMargin(terminal, { token: selection.token, product: ticket.product, orderType: ticket.orderType, quantity: String(qty), price: (ticket.orderType === 'L' || ticket.orderType === 'SL') ? String(priceNum) : '0', triggerPrice: (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? String(triggerNum) : '0', transactionType: ticket.side, exchange: selection.exchange });
            const mraw: Record<string, any> | null = m && typeof m === 'object' ? m : null;
            const layer1: Record<string, any> | null = mraw?.data && typeof mraw.data === 'object' ? mraw.data : null;
            const layer2: Record<string, any> | null = layer1?.data && typeof layer1.data === 'object' ? layer1.data : null;
            margin = { ...(mraw ?? {}), ...(layer1 ?? {}), ...(layer2 ?? {}) };
          } catch { margin = null; }
        }
        if (cancelled) return;
        if (!risk?.ok) { setPrecheck({ kind: 'UNKNOWN', label: stringifyDetail(risk?.error ?? 'Risk service unavailable.'), reasons: [], checks: {}, marginAvailable: null, marginMessage: null, marginRequired: null, checkedAt: Date.now() }); return; }
        const d = risk.data ?? {};
        const accepted = d.accepted === true;
        setPrecheck({
          kind: accepted ? 'PASS' : 'BLOCK',
          label: accepted ? 'Order passes active risk policy.' : 'Order is blocked by the Risk Engine.',
          reasons: Array.isArray(d.reasons) ? d.reasons : [], checks: d.checks ?? {},
          marginAvailable: caps.supportsMarginPreview ? (margin?.available === true) : null,
          marginMessage: caps.supportsMarginPreview ? (margin?.message ?? (margin?.rmsVldtd ? `Broker RMS: ${margin.rmsVldtd}` : null)) : 'This terminal has no margin preview API.',
          marginRequired: caps.supportsMarginPreview ? num(margin?.reqdMrgn ?? margin?.marginRequired ?? margin?.value) : null,
          checkedAt: Date.now(),
        });
      } catch (err: any) { if (cancelled) return; setPrecheck({ kind: 'UNKNOWN', label: `Risk check error: ${err?.message ?? 'network'}`, reasons: [], checks: {}, marginAvailable: null, marginMessage: null, marginRequired: null, checkedAt: Date.now() }); }
      finally { if (!cancelled) setChecking(false); }
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); setChecking(false); };
  }, [riskKey, caps, terminal, selection, ticket, effLtp, ltpNum, isDemo, loggedIn, authResolved]);

  // Positions
  const [positionsTick, setPositionsTick] = useState(0);
  useEffect(() => {
    if (!selection || (!loggedIn && !isDemo)) { setPositions(null); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await dedupFetch(`positions:${isDemo ? 'demo' : terminal}`, () => isDemo ? getDemoPositions() : getTerminalPositions(terminal));
        const rows = res?.data ?? res?.positions ?? null;
        if (!cancelled) setPositions(Array.isArray(rows) ? rows : null);
      } catch { if (!cancelled) setPositions(null); }
    };
    load();
    timer = setInterval(() => load(), 8000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [token, terminal, loggedIn, isDemo, positionsTick]);

  // Funds
  const [fundsTick, setFundsTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    TradingService.getFunds().then((r) => { if (!cancelled) setFunds({ availableMargin: Number(r.availableMargin) || 0, usedMargin: Number(r.usedMargin) || 0 }); }).catch(() => { if (!cancelled) setFunds(null); });
    return () => { cancelled = true; };
  }, [fundsTick]);

  const liveTrigger = useMemo(() => allTriggers.find((t) => t.status === 'ARMED' && String(t.token) === token), [allTriggers, token]);
  const liveTriggerPrice = num(liveTrigger?.triggerPrice);

  // Market status
  const marketStatus = systemMarket ? String(systemMarket.market_status ?? '') : '';
  const marketTone: 'success' | 'warning' | 'neutral' = marketStatus === 'OPEN' ? 'success' : marketStatus === 'CLOSED' ? (systemMarket?.is_weekend || systemMarket?.is_exchange_holiday ? 'neutral' : 'warning') : 'neutral';
  const marketLabel = marketStatus ? `Market ${marketStatus}` : 'Market · …';
  const brokerLabel = rt.brokerWsConnected === true ? 'WS up' : rt.brokerWsConnected === false ? 'WS down' : 'WS …';

  const updateForm = useCallback((patch: Partial<TicketState>) => { setTicket(prev => ({ ...prev, ...patch })); }, []);

  const handleSelect = useCallback((sel: InstrumentSelection, side?: 'BUY' | 'SELL') => {
    const safe = sanitizeSelection(sel);
    setSelectionRaw(safe);
    setSeedQuote(safe);
    setShowPreview(false);
    if (side) setTicket(t => t.side === side ? t : { ...t, side });
  }, []);

  const clearSelection = useCallback(() => { setSelection(null); setCircuitSnap(null); setSeedQuote(null); }, [setSelection]);

  // Circuit snap
  const liveRef = useRef(false);
  liveRef.current = ltpNum != null;
  useEffect(() => {
    if (!token) { setCircuitSnap(null); return; }
    let cancelled = false;
    const pull = (initial: boolean) => {
      if (cancelled || (!initial && liveRef.current)) return;
      getMarketWatchTickSnapshot([token]).then((res) => { if (cancelled) return; const row = res?.rows?.[token]; if (row && row.hasData !== false) setCircuitSnap(row); else if (initial) setCircuitSnap(null); }).catch(() => { if (cancelled && initial) setCircuitSnap(null); });
    };
    pull(true);
    const quick = setTimeout(() => pull(false), 2500);
    const id = setInterval(() => pull(false), 15000);
    return () => { cancelled = true; clearTimeout(quick); clearInterval(id); };
  }, [token]);

  // Validation
  const validation = useMemo(() => {
    const fieldErrors: Record<string, string> = {};
    const qty = parseInt(ticket.quantity, 10);
    const price = parseFloat(ticket.price);
    const ltp = ltpNum ?? seedLtp ?? 0;
    if (!Number.isInteger(qty) || qty < 1) fieldErrors.quantity = 'Enter a whole number greater than 0';
    if ((ticket.orderType === 'L' || ticket.orderType === 'SL') && (!Number.isFinite(price) || price <= 0)) fieldErrors.limitPrice = 'Enter a positive limit price';
    if (ticket.targetPrice?.trim() !== '' && ticket.targetPrice) { const t = parseFloat(ticket.targetPrice); if (!Number.isFinite(t) || t <= 0) fieldErrors.target = 'Enter a positive target price'; }
    if (ticket.slPrice?.trim() !== '' && ticket.slPrice) { const s = parseFloat(ticket.slPrice); if (!Number.isFinite(s) || s <= 0) fieldErrors.stopLoss = 'Enter a positive stop-loss price'; }
    const refPrice = ticket.orderType === 'MKT' ? ltp : (Number.isFinite(price) && price > 0 ? price : 0);
    const orderValueNum = qty * refPrice;
    const backendMargin = chargesPreview?.marginRequired != null ? Number(chargesPreview.marginRequired) : precheck.marginRequired != null ? Number(precheck.marginRequired) : null;
    const backendKnown = backendMargin != null && Number.isFinite(backendMargin) && backendMargin >= 0;
    const qtyOk = Number.isInteger(qty) && qty >= 1;
    const localMargin = qtyOk && marginPerShareVal > 0 ? marginPerShareVal * qty : null;
    const requiredMargin = backendKnown ? backendMargin : localMargin;
    const marginSource: 'server' | 'estimate' | null = backendKnown ? 'server' : (localMargin != null ? 'estimate' : null);
    const marginKnown = requiredMargin != null && Number.isFinite(requiredMargin) && requiredMargin >= 0;
    const available = funds?.availableMargin ?? null;
    return { fieldErrors, valid: Object.keys(fieldErrors).length === 0, qty, refPrice, orderValue: orderValueNum, requiredMargin: marginKnown ? requiredMargin : null, marginSource, perShare: marginPerShareVal > 0 ? marginPerShareVal : null, availableMargin: available, remainingMargin: marginKnown && available != null ? available - requiredMargin : null, hasShortfall: backendKnown && available != null && (isDemo || loggedIn) && backendMargin > available };
  }, [ticket, ltpNum, seedLtp, funds, chargesPreview, precheck.marginRequired, marginPerShareVal, isDemo, loggedIn]);

  const previewPrice = useMemo(() => { const raw = validation.refPrice; return (ticket.orderType === 'L' || ticket.orderType === 'SL') ? raw : bucketLtp(raw); }, [validation.refPrice, ticket.orderType]);

  const handlePlaceOrder = async () => {
    if (!validation.valid || !selection) return;
    setPlacing(true); setShowPreview(false); setExec({ phase: 'submitting', at: new Date().toISOString() });
    try {
      const base = { exchange: selection.exchange, token: selection.token, symbol: selection.symbol, transaction_type: ticket.side, product: ticket.product, order_type: ticket.orderType, quantity: String(Number(ticket.quantity)), price: (ticket.orderType === 'L' || ticket.orderType === 'SL') ? ticket.price : '0', trigger_price: (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? ticket.triggerPrice : '0', validity: ticket.validity, disclosed_quantity: '0' };
      let result: any;
      if (isDemo) {
        let ltpVal = ltpNum ?? (num(selection.ltp) != null && (num(selection.ltp) as number) > 0 ? (num(selection.ltp) as number) : 0);
        if (!(ltpVal > 0) && selection.token) {
          try { const snap = await getMarketWatchTickSnapshot([selection.token]); const row = snap?.rows?.[String(selection.token)]; if (num(row?.ltp) != null && (num(row?.ltp) as number) > 0) ltpVal = num(row?.ltp) as number; } catch {}
        }
        if (!(ltpVal > 0) && ticket.orderType === 'MKT') { setExec({ phase: 'failed', message: `No live price for ${selection.symbol} yet — the feed has no tick for it. Wait for LIVE status or pick a liquid stock, then retry. Nothing was placed.`, raw: { reason: 'LTP_UNAVAILABLE' } }); setPlacing(false); setExecId(e => e + 1); return; }
        result = await placeDemoOrder({ symbol: selection.symbol, tradingSymbol: selection.tradingSymbol ?? selection.symbol, exchange: selection.exchange, exchangeSegment: selection.exchangeSegment ?? selection.exchange, token: selection.token, transactionType: ticket.side, product: ticket.product, orderType: ticket.orderType, quantity: Number(ticket.quantity), price: (ticket.orderType === 'L' || ticket.orderType === 'SL') ? Number(ticket.price) : 0, triggerPrice: (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? Number(ticket.triggerPrice) : 0, validity: ticket.validity, ltp: ltpVal, amount: amountMargin || 0, lotSize: lotSizeNum, marginPerShare: marginPerShareVal || 0 });
      } else {
        result = await placeTerminalOrder(mode, base);
      }
      const demoOrder = isDemo ? (result?.demoOrder ?? {}) : {};
      const placed = isDemo ? demoOrder : (result?.order ?? result?.data ?? {});
      const rawStatus = String(placed?.status ?? placed?.orderStatus ?? result?.status ?? '').toUpperCase().trim();
      const accepted = isDemo ? (result?.data?.stat === 'Ok' || result?.accepted === true) : result?.ok === true;
      const orderId = placed?.orderId ?? result?.data?.n_ord_no ?? result?.orderId ?? null;
      if (!accepted) { setExec({ phase: 'failed', message: stringifyDetail(result?.data?.remarks ?? placed?.errorMessage ?? result?.detail ?? result?.error ?? 'Order was not accepted.'), raw: result }); }
      else if (FILLED_STATUSES.has(rawStatus)) { const filledQty = placed?.filledQuantity ?? demoOrder?.filledQuantity ?? null; const avg = demoOrder?.averagePrice ?? placed?.averagePrice ?? null; setExec({ phase: 'filled', status: rawStatus || 'COMPLETE', orderId, filledQuantity: filledQty ?? validation.qty, averagePrice: num(avg), raw: result }); setPositionsTick(t => t + 1); setFundsTick(t => t + 1); }
      else { const waitingFor = (ticket.orderType === 'L' || ticket.orderType === 'SL') ? Number(ticket.price) : (ticket.orderType === 'SL' || ticket.orderType === 'SL-M') ? Number(ticket.triggerPrice) : null; setExec({ phase: 'pending', status: rawStatus || (ticket.orderType === 'L' || ticket.orderType === 'SL' ? 'OPEN' : 'PENDING'), orderId, reason: stringifyDetail(placed?.remarks ?? placed?.reason ?? demoOrder?.remarks ?? demoOrder?.reason ?? ((ticket.orderType === 'L' || ticket.orderType === 'SL') ? `Waiting for the live LTP to reach the limit price.` : 'Waiting for the live LTP to trigger this order.')), waitingFor: Number.isFinite(waitingFor as number) && (waitingFor as number) > 0 ? waitingFor : null, raw: result }); setPositionsTick(t => t + 1); }
    } catch (err: any) { setExec({ phase: 'failed', message: stringifyDetail(err?.body?.detail ?? err?.message ?? 'Order request failed.'), raw: err ?? {} }); }
    finally { setPlacing(false); setExecId(e => e + 1); }
  };

  const confirmRequired = useCallback((side: 'BUY' | 'SELL') => { const c = getSettingsStore().getSettings().confirm; return side === 'BUY' ? c.confirmBuy : c.confirmSell; }, []);
  const isBUY = ticket.side === 'BUY';
  const isTouch = useTouchPointer();
  const useSlide = isTouch && confirmRequired(ticket.side);

  const requestPlace = () => { if (!validation.valid) return; if (ticket.orderType === 'MKT' && !(validation.refPrice > 0)) return; if (confirmRequired(ticket.side)) { setShowPreview(true); return; } handlePlaceOrder(); };
  const confirmBySlide = useCallback(() => { if (!validation.valid) return; if (ticket.orderType === 'MKT' && !(validation.refPrice > 0)) return; handlePlaceOrder(); }, [validation.valid, validation.refPrice, ticket.orderType]);
  const ackExec = useCallback(() => setExec(EMPTY_EXEC), []);

  const myPositions = useMemo(() => { if (!selection) return []; const sym = selection.symbol.toUpperCase(); if (rtPos && rtPos.symbol === sym) { if (!rtPos.position) return []; const n = normalizePosition(rtPos.position); return n.symbol.toUpperCase() === sym ? [n] : []; } return (positions ?? []).map(normalizePosition).filter(p => p.symbol.toUpperCase() === sym); }, [positions, symbol, rtPos]);

  const sessionTone = session.active ? 'success' : 'warning';
  const liveOrder = realtimeOrder && symbol && String(realtimeOrder.symbol ?? '').toUpperCase() === symbol.toUpperCase() ? realtimeOrder : null;
  const mktReady = ticket.orderType !== 'MKT' || validation.refPrice > 0;
  const canPlace = !placing && validation.valid && !!selection && mktReady;
  const fieldErrorList = Object.values(validation.fieldErrors);
  const fillHint = useMemo(() => { const limit = Number(ticket.price); if (!((ticket.orderType === 'L' || ticket.orderType === 'SL')) || ltpNum == null || !(limit > 0)) return null; return ticket.side === 'BUY' ? ltpNum <= limit : ltpNum >= limit; }, [ticket.orderType, ticket.side, ticket.price, ltpNum]);

  const engineBadges = ['risk_engine', 'search_engine', 'order_engine', 'storage_engine'] as const;
  const engineTone = (id: typeof engineBadges[number]): 'success' | 'warning' | 'danger' | 'neutral' => { const e: any = (engines as Record<string, any>)[id]; if (!e) return 'neutral'; const h = String(e.health ?? e.state ?? '').toUpperCase(); return h === 'HEALTHY' || h === 'RUNNING' ? 'success' : h === 'DEGRADED' ? 'warning' : h === 'UNHEALTHY' || h === 'ERROR' ? 'danger' : 'neutral'; };
  const engineOk = engineBadges.filter(id => engineTone(id) === 'success').length;

  const orderResetKey = `${token}|${ticket.side}|${ticket.orderType}|${ticket.product}`;

  const money0 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : `${unit}${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  const money2 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? '—' : `${unit}${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Insight sections
  const riskTone: InsightSection['tone'] = checking ? 'info' : precheck.kind === 'PASS' ? 'success' : precheck.kind === 'WARNING' ? 'warning' : precheck.kind === 'BLOCK' || precheck.kind === 'EMERGENCY_BLOCK' ? 'danger' : 'neutral';
  const riskValue = checking ? 'checking…' : precheck.kind === 'PASS' ? 'PASS' : precheck.kind === 'BLOCK' ? 'BLOCK' : precheck.kind === 'EMERGENCY_BLOCK' ? 'LOCKED' : precheck.kind === 'WARNING' ? 'WARN' : 'UNKNOWN';
  const chargesValue = chargesPreview?.total != null ? `${unit}${chargesPreview.total.toFixed(2)}` : '—';
  const autoSqValue = liveTrigger && liveTriggerPrice != null && liveTriggerPrice > 0 ? `${liveTrigger.kind === 'TARGET' ? 'T' : 'S'} ${unit}${liveTriggerPrice.toFixed(2)}` : 'off';

  const insightSections = useMemo<InsightSection[]>(() => {
    if (!selection) return [];
    return [
      { id: 'risk', label: 'Risk', value: riskValue, tone: riskTone, icon: Shield, node: <RiskMarginPanel precheck={precheck} supporting={caps.supportsMarginPreview} checking={checking} loggedIn={loggedIn} /> },
      { id: 'charges', label: 'Charges', value: chargesValue, tone: 'neutral', icon: Receipt, node: <ChargesPanel caps={caps} selection={selection} ticket={ticket} price={previewPrice} onPreview={setChargesPreview} /> },
      { id: 'targets', label: 'Targets', value: autoSqValue, tone: liveTrigger ? 'success' : 'neutral', icon: Target, node: (<div className="space-y-2">{liveTrigger && liveTriggerPrice != null && liveTriggerPrice > 0 && (<p className="flex items-center gap-1.5 rounded-xl border border-success/25 bg-success/5 px-2.5 py-2 text-[11px] text-muted-foreground"><Activity className="h-3.5 w-3.5 shrink-0 text-success" /> Auto square-off armed · {liveTrigger.kind === 'TARGET' ? 'Target' : 'Stop loss'} {unit}{liveTriggerPrice.toFixed(2)}</p>)}<TargetPanel mode={mode} caps={caps} symbol={symbol} loggedIn={loggedIn} /></div>) },
      { id: 'basket', label: 'Basket', value: `${basketItems.length} leg${basketItems.length === 1 ? '' : 's'}`, tone: basketItems.length > 0 ? 'info' : 'neutral', icon: Boxes, node: (<div className="rounded-xl border border-border/60 bg-card p-2.5"><div className="flex items-center gap-1.5"><Boxes className="h-4 w-4 text-primary" /><span className="text-[12px] font-extrabold tracking-tight">Basket</span><span className="text-[10px] text-muted-foreground">{basketItems.length} legs</span><Input value={basketName} onChange={e => setBasketName(e.target.value)} className="ml-auto h-8 w-32 rounded-lg border bg-card px-2 text-[11px] font-semibold" placeholder="Basket name" /></div><div className="mt-2 flex gap-1.5"><Button variant="outline" size="sm" className="h-9 flex-1 gap-1 rounded-xl border-primary/30 bg-primary/5 text-[11px] font-bold text-primary hover:bg-primary/10" onClick={() => { if (!selection || !validation.valid || !mktReady) return; setBasketItems(prev => [...prev, { id: `${selection.symbol}-${Date.now()}`, selection, ticket: { ...ticket }, addedAt: Date.now() }]); }} disabled={!validation.valid || placing || !mktReady}><Boxes className="h-3 w-3" /> Add {symbol}</Button>{basketItems.length > 0 && <Button variant="ghost" size="sm" className="h-9 rounded-xl px-3 text-[11px]" onClick={() => setBasketItems([])}>Clear</Button>}</div>{basketItems.length > 0 && <div className="mt-2 max-h-40 space-y-1 overflow-auto pr-1">{basketItems.map(item => (<div key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-border/40 bg-muted/30 px-2 py-1.5 text-[10px]"><span className="font-mono font-bold">{item.selection.symbol}</span><span className="tabular-nums text-muted-foreground">{item.ticket.side} · {item.ticket.quantity} × {item.ticket.orderType} · {item.ticket.product}</span><button onClick={() => setBasketItems(prev => prev.filter(p => p.id !== item.id))} className="font-medium text-destructive hover:underline" aria-label={`Remove ${item.selection.symbol}`}>✕</button></div>))}</div>}</div>) },
    ];
  }, [selection, riskValue, riskTone, precheck, checking, caps, loggedIn, chargesValue, chargesPreview, autoSqValue, liveTrigger, mode, symbol, previewPrice, ticket, basketItems.length, basketName, validation.valid, placing, mktReady]);

  return (
    <div className="dense-ui mx-auto flex min-h-full w-full max-w-5xl flex-col gap-1.5 pb-24 md:pb-2 animate-fade-in">
      {/* Status line */}
      <div className="flex items-center gap-1.5 overflow-x-auto px-0.5 text-[10px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="shrink-0 text-[13px] font-bold tracking-tight text-foreground">{caps.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <StatusBadge status={sessionTone} label={session.active ? 'Session' : 'No session'} />
          <StatusBadge status={marketTone} label={marketLabel} />
          <StatusBadge status={dataStatus === 'LIVE' ? 'success' : dataStatus === 'OFFLINE' ? 'danger' : 'warning'} label={dataStatus} />
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card px-1.5 py-0.5 font-semibold tabular-nums text-muted-foreground" title={`Engines: ${engineOk}/${engineBadges.length} healthy · broker WS ${brokerLabel}`}>
            <Activity className="h-2.5 w-2.5" />
            <span className={cn('h-1.5 w-1.5 rounded-full', enginesConnected ? 'bg-success animate-pulse' : 'bg-muted-foreground/30')} />
            {engineOk}/{engineBadges.length}
          </span>
        </span>
      </div>

      {/* Search */}
      <SafeRegion label="Search" resetKey={mode}>
        <div className="sticky top-0 z-20 -mx-3 border-b border-border/50 bg-background/95 px-3 py-1.5 backdrop-blur md:-mx-6 md:px-6">
          <InstrumentSearch onSelect={handleSelect} selectedSymbol={symbol} selectedSelection={selection} onClear={clearSelection} disabled={placing} />
        </div>
      </SafeRegion>

      {/* Main content */}
      {selection ? (
        <>
          {/* Order Card */}
          <SafeRegion label="Order card" resetKey={orderResetKey}>
            <section className={cn('overflow-hidden rounded-xl border bg-card shadow-soft', isBUY ? 'border-success/40' : 'border-destructive/40')}>
              <SelectedStockCard
                selection={selection} quote={quote} caps={caps} marginRequired={validation.requiredMargin}
                orderValue={validation.orderValue} isBUY={isBUY} availableMargin={validation.availableMargin}
                quantity={ticket.quantity} perShare={validation.perShare} marginSource={validation.marginSource}
              />

              <div className="space-y-1.5 p-2">
                {!realtime.connected && (
                  <div className="flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/[0.06] px-2 py-1 text-[10px] font-medium text-warning">
                    <Info className="h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1">Realtime offline — snapshot refreshes every 15s. <a href="/login" className="font-bold underline underline-offset-2">Log in</a> for live ticks.</span>
                  </div>
                )}

                {!isDemo && !loggedIn ? (
                  authResolved ? <AuthGate terminal={terminal} onAuthenticated={() => setLoggedIn(true)} /> : (
                    <p className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2 py-2 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Connecting trading session…
                    </p>
                  )
                ) : (
                  <OrderTicket
                    caps={caps} ticket={ticket} onChange={next => { setTicket(next); if (next.orderType === 'MKT') updateForm({ price: '0' }); }}
                    quote={quote} disabled={placing} symbol={symbol} lotSize={selection.lotSize} selection={selection}
                  />
                )}

                {/* Margin/Value/Avail */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5 text-[10px]">
                  <span className="flex items-center gap-1"><Shield className="h-3 w-3 text-muted-forecast" /><span className="font-bold uppercase tracking-wider text-muted-foreground">Margin</span><span className="font-mono text-[11px] font-bold tabular-nums text-warning">{money0(validation.requiredMargin)}{validation.marginSource === 'estimate' && <span className="ml-0.5 text-[8px] uppercase text-muted-foreground">est</span>}</span></span>
                  <span className="flex items-center gap-1"><span className="font-bold uppercase tracking-wider text-muted-foreground">Avail</span><span className="font-mono text-[11px] font-bold tabular-nums text-success">{money0(validation.availableMargin)}</span></span>
                  <span className="flex items-center gap-1"><span className="font-bold uppercase tracking-wider text-muted-foreground">After</span><span className="font-mono text-[11px] font-bold tabular-nums">{money0(validation.remainingMargin)}</span></span>
                  {myPositions[0]?.netQty != null && (
                    <span className="ml-auto flex items-center gap-1.5 tabular-nums"><span className="font-bold uppercase tracking-wider text-muted-foreground">Pos</span><span className={cn('font-mono text-[11px] font-bold', pnlTone(myPositions[0].pnl))}>{Number(myPositions[0].netQty) > 0 ? '+' : ''}{myPositions[0].netQty}</span>{myPositions[0].avg != null && <span className="text-muted-foreground">@ {Number(myPositions[0].avg).toFixed(2)}</span>}</span>
                  )}
                </div>

                {validation.hasShortfall && (
                  <p className="flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-[10px] font-semibold text-destructive">
                    <Info className="h-3 w-3 shrink-0" /> Insufficient margin — {money0(Math.abs(validation.remainingMargin ?? 0))} short
                  </p>
                )}

                {fieldErrorList.length > 0 && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-2 py-1 text-[10px] font-medium text-destructive">
                    {fieldErrorList.map(msg => <p key={msg} className="flex items-center gap-1">{msg}</p>)}
                  </div>
                )}

                {!mktReady && validation.valid && (
                  <p className="rounded-lg border border-warning/30 bg-warning/[0.06] px-2 py-1 text-[10px] font-medium text-warning">
                    Live price not yet available — a market order cannot be priced until the LTP loads.
                  </p>
                )}

                <ExecutionState exec={exec} execId={execId} terminal={terminal} symbol={symbol ?? ''} realtimeOrder={liveOrder} onAck={ackExec} />

                {/* Insights */}
                <SafeRegion label="Insights" resetKey={orderResetKey}>
                  <InsightSheet sections={insightSections} />
                </SafeRegion>
              </div>
            </section>
          </SafeRegion>

          {/* Order Bar */}
          <SafeRegion label="Action bar" resetKey={orderResetKey}>
            <div data-verify="trade-order-bar" className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-border/50 bg-background/95 px-3 py-2 backdrop-blur-md md:sticky md:bottom-0 md:z-20 md:-mx-6 md:px-6 md:backdrop-blur-sm">
              <SlideToOrder side={ticket.side} label={`${ticket.side} ${symbol ?? ''}`.trim()} disabled={!canPlace} placing={placing} swipe={useSlide} onConfirm={useSlide ? confirmBySlide : requestPlace} />
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px]">
                <span className="flex min-w-0 items-center gap-1.5 font-mono tabular-nums text-muted-foreground">
                  <span className="truncate">{ticket.orderType === 'MKT' ? 'MKT' : `@ ${unit}${Number(ticket.price || 0).toFixed(2)}`} {' · '} {ticket.product} · {ticket.validity}</span>
                  <span className="hidden sm:inline"> {' · '} {validation.valid ? `×${validation.qty}` : 'qty —'}</span>
                  <span className="hidden md:inline"> {' · '} Mgn {money0(validation.requiredMargin)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="font-mono tabular-nums text-muted-foreground">LTP {ltpNum != null ? `${unit}${ltpNum.toFixed(2)}` : '—'}</span>
                  <button type="button" onClick={() => updateForm({ side: isBUY ? 'SELL' : 'BUY' })} className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-1.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95" aria-label={`Switch order side to ${isBUY ? 'SELL' : 'BUY'}`}><ArrowLeftRight className="h-3 w-3" />{isBUY ? 'SELL' : 'BUY'}</button>
                </span>
              </div>
            </div>
          </SafeRegion>

          {/* Preview Modal */}
          {showPreview && (
            <SafeRegion label="Confirm dialog" resetKey={orderResetKey}>
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={() => setShowPreview(false)}>
                <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-xl border border-border bg-card shadow-2xl" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-4 pt-3">
                    <h3 className="text-sm font-semibold">Review order</h3>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-lg" onClick={() => setShowPreview(false)}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                  <div className="space-y-3 p-4">
                    <div className={cn('rounded-lg border p-2.5', isBUY ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10')}>
                      <div className={cn('text-base font-extrabold', isBUY ? 'text-success' : 'text-destructive')}>{ticket.side} {selection?.tradingSymbol || selection?.symbol}</div>
                      <div className="text-[11px] text-muted-foreground">{selection?.exchangeSegment || selection?.exchange} · {ticket.product} · {ticket.orderType === 'MKT' ? 'MARKET' : ticket.orderType} · {ticket.validity}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      {[
                        ['Quantity', ticket.quantity],
                        [ticket.orderType === 'MKT' ? 'Execution' : 'Limit price', ticket.orderType === 'MKT' ? 'Market' : `${unit}${ticket.price}`],
                        ['LTP', ltpNum != null ? `${unit}${ltpNum.toFixed(2)}` : '—'],
                        ['Order value', `${unit}${Number(validation.orderValue).toFixed(2)}`],
                        ['Margin', validation.requiredMargin != null ? `${unit}${validation.requiredMargin.toFixed(2)}` : 'UNAVAILABLE'],
                        ['Charges', chargesPreview?.total != null ? `${unit}${chargesPreview.total.toFixed(2)}` : '—'],
                      ].map(([k, v]) => (
                        <div key={k}><div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{k}</div><div className="font-mono text-[12px] font-bold tabular-nums">{v}</div></div>
                      ))}
                    </div>
                    {fillHint === false && (
                      <p className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[11px] font-medium text-warning">
                        The live LTP has not reached your limit price — this order will rest as <strong>PENDING</strong> until it does.
                      </p>
                    )}
                    <p className="flex items-start gap-1.5 rounded-lg border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning"><Info className="mt-px h-3.5 w-3.5 shrink-0" /> This order will be sent to the exchange. Please confirm.</p>
                    <div className="flex gap-2">
                      <Button variant="outline" className="h-11 flex-1 rounded-lg text-[12px] font-semibold" onClick={() => setShowPreview(false)} disabled={placing}>Back</Button>
                      <Button className={cn(SIDE_CLASS[ticket.side], 'h-11 flex-1 gap-1 rounded-lg text-[12px] font-bold')} onClick={handlePlaceOrder} disabled={placing || !validation.valid}>{placing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Confirm ${ticket.side}`}</Button>
                    </div>
                  </div>
                </div>
              </div>
            </SafeRegion>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/50 px-4 py-8 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"><Search className="h-5 w-5" /></span>
          <p className="text-sm font-semibold">Pick a stock to start</p>
          <p className="text-[11px] text-muted-foreground">Search above — the order card opens right here the moment you tap a result.</p>
        </div>
      )}
    </div>
  );
}