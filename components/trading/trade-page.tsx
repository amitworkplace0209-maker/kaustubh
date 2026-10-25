'use client';

/**
 * TRADE PAGE — the order ticket (rebuilt from scratch).
 *
 * This component is the single TRUTH BOUNDARY of the page: it owns the
 * selected instrument, the ticket, the live quote, the risk verdict, the
 * account state and the order lifecycle. Every child is presentational.
 *
 * Where the numbers come from (nothing here is invented):
 *   · LTP / day context  → the shared browser tick stream (SSE, same-origin),
 *                          then the central tick-store snapshot
 *                          (`/api/market-watch/tick-snapshot`), then the
 *                          on-demand broker quote, then the search seed.
 *   · Order types / products / margin API / charge model
 *                        → the BACKEND capability registry
 *                          (`GET /api/terminal/list` → `capabilities`).
 *   · Risk verdict       → `POST /api/services/risk/validate` (preview phase:
 *                          it never records an order intent).
 *   · Margin             → the broker margin API when the terminal supports
 *                          it, otherwise an estimate that is labelled `est`.
 *   · Charges            → the app's canonical charge engine
 *                          (`lib/charge-engine.ts`, statutory rates in
 *                          `config/`).
 *
 * Order routing is unchanged and deliberate: the Dummy terminal goes to the
 * paper engine (`/api/trade/demo/order`), a real broker goes to the Common
 * Trading Core (`/api/terminal/order`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Loader2, Monitor, Search as SearchIcon, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getSettingsStore,
  useTradingMode,
  type TradingMode,
} from '@/lib/settings-store';
import {
  ensureTerminalAuth,
  getTerminalMargin,
  getTerminalPositions,
  placeTerminalOrder,
  riskPrecheck,
  toTerminalId,
  type TerminalId,
} from '@/lib/terminal-service';
import { TradingService } from '@/lib/trading-service';
import { getDemoPositions, placeDemoOrder } from '@/lib/api';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { dedupFetch } from '@/lib/request-dedup';
import { setBasketDraft } from '@/lib/basket-draft';
import { marginPerShare } from '@/lib/order-workspace';
import { useEngines } from '@/lib/engine-realtime';
import { useInstrumentTick } from '@/hooks/use-instrument-tick';
import { useOnDemandQuote } from '@/hooks/use-on-demand-quote';
import { useMarketWatchSnapshot } from '@/hooks/use-market-watch-snapshot';
import { useTouchPointer } from '@/hooks/use-media-query';
import { useTriggers } from '@/lib/trigger-store';
import { useSystem } from '@/components/system-provider';
import { useRealtime } from '@/components/realtime-provider';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';

/** Terminal-aware `positions` WS document (`connection_engine.snapshots`). */
type PositionsDocument = {
  terminal?: string;
  isDemo?: boolean;
  positions?: Array<Record<string, unknown>>;
  stat?: string;
};
import type {
  ExecState,
  InstrumentSelection,
  LiveQuote,
  PrecheckSummary,
  TicketState,
} from '@/components/orders/trade/types';
import { capsFor } from '@/components/orders/trade/capabilities';
import { useTerminalCapabilities } from '@/components/trading/terminal-capabilities';
import { SafeRegion } from './safe-region';
import { InstrumentSearch } from './instrument-search';
import { TerminalRail } from './terminal-rail';
import { QuoteHeader } from './quote-header';
import { OrderTicketCard } from './order-ticket';
import { MarginStrip } from './margin-strip';
import { ExecutionPanel } from './execution-panel';
import { TradeInspector } from './trade-inspector';
import { OrderActions } from './order-actions';
import { ConfirmOrderDialog } from './confirm-order-dialog';
import { AuthGate } from './auth-gate';

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

/** Normalise anything the search engine hands back into the selection shape. */
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
    source: sel.source ? str(sel.source) : undefined,
    asOf: sel.asOf ? str(sel.asOf) : undefined,
  };
}

function stringifyDetail(d: unknown): string {
  if (typeof d === 'string' && d) return d;
  if (d == null) return 'unknown error';
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
}

/**
 * Bucket a price so a risk pre-check is not re-run on every tick.
 * 1 % buckets: the risk verdict only depends on the price through the
 * order-value and margin gates, both of which move far slower than a tick.
 */
function bucketPrice(v: number | null | undefined, pct = 0.01): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const step = Math.max(0.01, Math.round(n * pct * 100) / 100);
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

export function TradePage() {
  const mode: TradingMode = useTradingMode();
  const terminal: TerminalId = toTerminalId(mode);
  const isDemo = mode === 'dummy';
  const { caps, source: capsSource } = useTerminalCapabilities(terminal);
  const fallbackCaps = useMemo(() => capsFor(terminal), [terminal]);
  const unit = caps.virtualCurrency ? 'C' : (caps.accountCurrency || fallbackCaps.accountCurrency);

  // ---------------------------------------------------------------- state
  const [selection, setSelection] = useState<InstrumentSelection | null>(null);
  const [seedQuote, setSeedQuote] = useState<InstrumentSelection | null>(null);
  const [ticket, setTicket] = useState<TicketState>(() => ({
    side: 'BUY',
    product: caps.products[0] ?? 'MIS',
    orderType: 'MKT',
    quantity: '1',
    price: '',
    triggerPrice: '',
    validity: 'DAY',
    targetPrice: '',
    slPrice: '',
  }));
  const [exec, setExec] = useState<ExecState>(EMPTY_EXEC);
  const [execNonce, setExecNonce] = useState(0);
  const [placing, setPlacing] = useState(false);
  const [precheck, setPrecheck] = useState<PrecheckSummary>({
    kind: 'UNKNOWN',
    label: 'Pick an instrument to see the risk verdict.',
    reasons: [],
    checks: {},
    marginAvailable: null,
    marginMessage: null,
    marginRequired: null,
    checkedAt: null,
  });
  const [checking, setChecking] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [authResolved, setAuthResolved] = useState(false);
  const [positions, setPositions] = useState<Record<string, any>[] | null>(null);
  const [funds, setFunds] = useState<{ availableMargin: number; usedMargin: number } | null>(null);
  const [basketName, setBasketName] = useState('My Basket');
  const [basketLegs, setBasketLegs] = useState<
    Array<{ id: string; selection: InstrumentSelection; ticket: TicketState; addedAt: number }>
  >([]);
  const [showConfirm, setShowConfirm] = useState(false);
  const [feedState, setFeedState] = useState<'OFFLINE' | 'WAITING' | 'LIVE' | 'STALE'>('WAITING');

  const symbol = selection?.symbol ?? '';
  const token = selection?.token != null ? String(selection.token) : '';
  const exchangeSegment = selection?.exchangeSegment || selection?.exchange || '';

  // ------------------------------------------------------------- contexts
  const rt = useRealtime();
  const systemMarket = useSystem().market;
  const { engines, connected: enginesConnected } = useEngines();
  const triggers = useTriggers();

  // ---------------------------------------------------------- live prices
  const identity = useMemo(
    () => (selection ? { token: selection.token, symbol: selection.symbol } : null),
    [selection],
  );
  const tick = useInstrumentTick(identity, !!selection);
  const onDemand = useOnDemandQuote(
    useMemo(
      () => (selection ? { token: selection.token, symbol: selection.symbol, exchange: exchangeSegment } : null),
      [selection, exchangeSegment],
    ),
    !!selection,
    tick.quote?.ltp != null,
  );
  const snapshot = useMarketWatchSnapshot(token || null, { paused: tick.quote?.ltp != null });

  // ------------------------------------------------------------- session
  useEffect(() => {
    if (isDemo) {
      setLoggedIn(true);
      setAuthResolved(true);
      return;
    }
    let cancelled = false;
    ensureTerminalAuth().then((ok) => {
      if (cancelled) return;
      if (ok) setLoggedIn(true);
      setAuthResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isDemo]);

  // The app JWT only proves operator auth; the BROKER session is owned by the
  // backend. Follow the live session snapshot so an expired Kotak session can
  // never leave a green "Session" pill on screen.
  useEffect(() => {
    if (isDemo || rt.sessionActive === 'UNKNOWN') return;
    setLoggedIn(rt.sessionActive);
  }, [isDemo, rt.sessionActive]);

  const sessionActive = isDemo || (rt.sessionActive === 'UNKNOWN' ? loggedIn : rt.sessionActive);

  // ------------------------------------------------------- quote assembly
  const quote = useMemo<LiveQuote | null>(() => {
    if (!selection) return null;

    const streamed = tick.quote?.ltp != null ? tick.quote : null;
    const snap = snapshot.row;
    const rest = streamed ? null : onDemand.quote;
    const seed = streamed || rest?.ltp != null || snap?.ltp != null ? null : seedQuote;

    const prevClose =
      streamed?.prevClose ?? num(snap?.prevClose) ?? rest?.prevClose ?? seed?.prevClose ?? null;
    const ltp =
      streamed?.ltp ?? num(snap?.ltp) ?? rest?.ltp ?? (seed?.ltp != null ? seed.ltp : null) ?? null;

    const change =
      streamed?.change ??
      num(snap?.change) ??
      rest?.change ??
      seed?.change ??
      (prevClose != null && ltp != null ? ltp - prevClose : null);
    const changePct =
      streamed?.changePct ??
      num(snap?.changePercent) ??
      rest?.changePct ??
      seed?.changePct ??
      (prevClose != null && prevClose !== 0 && change != null ? (change / prevClose) * 100 : null);

    const source = streamed
      ? 'live tick stream'
      : rest?.ltp != null
        ? rest.stale
          ? rest.source === 'last_close'
            ? 'last close (broker)'
            : 'last trade (broker)'
          : 'broker quote'
        : snap?.ltp != null
          ? 'tick store snapshot'
          : seed?.ltp != null
            ? 'search snapshot'
            : 'no price yet';

    return {
      ltp,
      open: streamed?.open ?? num(snap?.open) ?? rest?.open ?? null,
      high: streamed?.high ?? num(snap?.high) ?? rest?.high ?? null,
      low: streamed?.low ?? num(snap?.low) ?? rest?.low ?? null,
      close: prevClose,
      volume: streamed?.volume ?? num(snap?.volume) ?? null,
      change,
      changePct,
      upperCircuit: streamed?.upperCircuit ?? num(snap?.upperCircuit) ?? num(seed?.upperCircuit) ?? null,
      lowerCircuit: streamed?.lowerCircuit ?? num(snap?.lowerCircuit) ?? num(seed?.lowerCircuit) ?? null,
      source,
      sourceId: streamed ? 'sse' : rest?.ltp != null ? rest.source : snap?.ltp != null ? 'tick_store' : 'search',
      asOf: rest?.asOf ?? (snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : null),
      ts: streamed?.ts ?? (snapshot.updatedAt ?? Date.now()),
      stale: !streamed,
      raw: {},
    };
  }, [selection, tick.quote, snapshot.row, snapshot.updatedAt, onDemand.quote, seedQuote]);

  const ltp = quote?.ltp ?? null;

  // ---------------------------------------------------------- feed status
  // The poll reads the LATEST values through refs on purpose: depending on
  // `quote.ts` in the effect dependencies re-created the interval on every
  // tick (the timestamp changes with every frame), so the interval never got
  // to fire and the feed badge stayed frozen at its first value.
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const ltpRef = useRef(ltp);
  ltpRef.current = ltp;
  const sseConnectedRef = useRef(tick.connected);
  sseConnectedRef.current = tick.connected;

  useEffect(() => {
    const t = setInterval(() => {
      const price = ltpRef.current;
      if (price == null) {
        setFeedState(sseConnectedRef.current ? 'WAITING' : 'OFFLINE');
        return;
      }
      const ts = quoteRef.current?.ts ?? Date.now();
      setFeedState(Date.now() - ts > 5000 ? 'STALE' : 'LIVE');
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // The paper engine prices its fills from the live feed. Feed it only when
  // the price actually moved, and only for the Dummy terminal.
  const lastFedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isDemo || !symbol || ltp == null || ltp <= 0) return;
    if (lastFedRef.current === ltp) return;
    lastFedRef.current = ltp;
    feedDummyLtp(symbol, ltp);
  }, [isDemo, symbol, ltp]);

  // -------------------------------------------------------------- sizing
  const lotSize = useMemo(() => {
    const l = num(selection?.lotSize);
    return l != null && l >= 1 ? Math.round(l) : 1;
  }, [selection?.lotSize]);

  const needsPrice = ticket.orderType === 'L' || ticket.orderType === 'SL';
  const needsTrigger = ticket.orderType === 'SL' || ticket.orderType === 'SL-M';
  const refPrice = needsPrice ? num(ticket.price) : ltp;

  const perShare = useMemo(
    () =>
      marginPerShare({
        price: refPrice,
        product: ticket.product,
        oneQtyMargin: selection?.oneQtyMargin,
      }),
    [refPrice, ticket.product, selection?.oneQtyMargin],
  );

  // ------------------------------------------------------ risk pre-check
  // The key contains the ORDER INTENT plus a 1 % price bucket. The effect
  // depends on the key ONLY — depending on the raw LTP re-fired the pre-check
  // on every tick (a request every ~2 s against the Risk Engine).
  const riskKey = [
    terminal,
    token,
    symbol,
    ticket.side,
    ticket.product,
    ticket.orderType,
    ticket.quantity,
    needsPrice ? ticket.price : '',
    needsTrigger ? ticket.triggerPrice : '',
    bucketPrice(ltp) ?? '',
    sessionActive ? '1' : '0',
  ].join('|');

  const precheckRef = useRef(precheck);
  precheckRef.current = precheck;

  useEffect(() => {
    if (!selection) {
      setPrecheck({
        kind: 'UNKNOWN',
        label: 'Pick an instrument to see the risk verdict.',
        reasons: [],
        checks: {},
        checkedAt: null,
      });
      setChecking(false);
      return;
    }
    if (!sessionActive) {
      setPrecheck({
        kind: 'EMERGENCY_BLOCK',
        label: 'Sign in to unlock trading actions.',
        reasons: [],
        checks: {},
        checkedAt: null,
      });
      setChecking(false);
      return;
    }
    if (!needsPrice && ltp == null) {
      setPrecheck({
        kind: 'UNKNOWN',
        label: 'Waiting for the market price…',
        reasons: [],
        checks: {},
        checkedAt: null,
      });
      setChecking(false);
      return;
    }
    const qty = Number(ticket.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setPrecheck({
        kind: 'UNKNOWN',
        label: 'Enter a whole-number quantity of at least 1.',
        reasons: [],
        checks: {},
        checkedAt: null,
      });
      setChecking(false);
      return;
    }
    if (needsPrice && !(num(ticket.price) ?? 0 > 0)) {
      setPrecheck({
        kind: 'UNKNOWN',
        label: 'Enter a positive limit price.',
        reasons: [],
        checks: {},
        checkedAt: null,
      });
      setChecking(false);
      return;
    }
    if (needsTrigger && !(num(ticket.triggerPrice) ?? 0 > 0)) {
      setPrecheck({
        kind: 'UNKNOWN',
        label: 'Enter a positive trigger price.',
        reasons: [],
        checks: {},
        checkedAt: null,
      });
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const risk = await riskPrecheck({
          terminal,
          symbol: selection.symbol,
          token: selection.token,
          exchange: selection.exchange,
          transaction_type: ticket.side,
          product: ticket.product,
          order_type: ticket.orderType,
          quantity: String(qty),
          price: needsPrice ? String(num(ticket.price) ?? 0) : '0',
          trigger_price: needsTrigger ? String(num(ticket.triggerPrice) ?? 0) : '0',
          expected_ltp: bucketPrice(ltp) ?? 0,
        });
        if (cancelled) return;
        if (!risk?.ok) {
          setPrecheck({
            kind: 'UNKNOWN',
            label: stringifyDetail(risk?.error ?? 'Risk service unavailable.'),
            reasons: [],
            checks: {},
            checkedAt: Date.now(),
          });
          return;
        }
        const d = risk.data ?? {};
        const reasons: string[] = Array.isArray(d.reasons) ? d.reasons : [];
        // A duplicate-suppression notice is a WARNING, not a hard block: it
        // means "an identical order was sent moments ago", which the operator
        // should see — but it is not a policy violation.
        const onlyDuplicate = reasons.length > 0 && reasons.every((r) => /duplicate/i.test(r));
        const accepted = d.accepted === true;
        setPrecheck({
          kind: accepted ? 'PASS' : onlyDuplicate ? 'WARNING' : 'BLOCK',
          label: accepted
            ? 'Order passes the active risk policy.'
            : onlyDuplicate
              ? 'An identical order was sent moments ago — the broker will refuse a repeat within the suppression window.'
              : 'Order is blocked by the Risk Engine.',
          reasons,
          checks: d.checks ?? {},
          checkedAt: Date.now(),
        });
      } catch (err: any) {
        if (cancelled) return;
        setPrecheck({
          kind: 'UNKNOWN',
          label: `Risk check error: ${err?.message ?? 'network'}`,
          reasons: [],
          checks: {},
          checkedAt: Date.now(),
        });
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `riskKey` is the ONLY dependency: it already encodes every input that
    // can change the verdict.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riskKey]);

  // --------------------------------------------------- broker margin view
  const [marginPreview, setMarginPreview] = useState<{
    required: number | null;
    message: string | null;
    available: boolean | null;
  } | null>(null);

  const marginKey = [terminal, token, ticket.product, ticket.orderType, ticket.quantity, ticket.price, ticket.triggerPrice].join('|');
  useEffect(() => {
    if (!caps.supportsMarginPreview || !selection || !sessionActive) {
      setMarginPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const m = await getTerminalMargin(terminal, {
          token: selection.token,
          product: ticket.product,
          orderType: ticket.orderType,
          quantity: ticket.quantity,
          price: needsPrice ? String(num(ticket.price) ?? 0) : '0',
          triggerPrice: needsTrigger ? String(num(ticket.triggerPrice) ?? 0) : '0',
          transactionType: ticket.side,
          exchange: selection.exchange,
        });
        if (cancelled) return;
        const raw: Record<string, any> | null = m && typeof m === 'object' ? m : null;
        const layer1: Record<string, any> | null = raw?.data && typeof raw.data === 'object' ? raw.data : null;
        const layer2: Record<string, any> | null = layer1?.data && typeof layer1.data === 'object' ? layer1.data : null;
        const merged = { ...(raw ?? {}), ...(layer1 ?? {}), ...(layer2 ?? {}) };
        setMarginPreview({
          required: num(merged.reqdMrgn ?? merged.marginRequired ?? merged.value),
          message: merged.message ?? (merged.rmsVldtd ? `Broker RMS: ${merged.rmsVldtd}` : null),
          available: typeof merged.available === 'boolean' ? merged.available : null,
        });
      } catch {
        if (!cancelled) setMarginPreview(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marginKey, caps.supportsMarginPreview, sessionActive]);

  // -------------------------------------------------------- account state
  // The `positions` WS document is terminal-aware (it always describes the
  // ACTIVE terminal) and is pushed on subscribe and on every change — the 8 s
  // re-fetch is only a fallback while the socket cannot deliver, or while the
  // document's terminal does not match this page's demo mode.
  const [positionsNonce, setPositionsNonce] = useState(0);
  const positionsLive = useRealtimeChannel<PositionsDocument>('positions', {
    enabled: !!selection && sessionActive,
  });
  const positionsDoc = positionsLive.data;
  useEffect(() => {
    if (!selection || !sessionActive) {
      setPositions(null);
      return;
    }
    // Guard: only trust the snapshot when its terminal matches the page mode.
    if (
      positionsDoc &&
      Boolean(positionsDoc.isDemo) === isDemo &&
      Array.isArray(positionsDoc.positions)
    ) {
      setPositions(positionsDoc.positions);
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await dedupFetch(`positions:${isDemo ? 'demo' : terminal}`, () =>
          isDemo ? getDemoPositions() : getTerminalPositions(terminal),
        );
        const rows = res?.data ?? res?.positions ?? null;
        if (!cancelled) setPositions(Array.isArray(rows) ? rows : null);
      } catch {
        if (!cancelled) setPositions(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selection, terminal, sessionActive, isDemo, positionsNonce, positionsDoc]);

  const [fundsNonce, setFundsNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    TradingService.getFunds()
      .then((r) => {
        if (cancelled) return;
        setFunds({
          availableMargin: Number(r.availableMargin) || 0,
          usedMargin: Number(r.usedMargin) || 0,
        });
      })
      .catch(() => {
        if (!cancelled) setFunds(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fundsNonce]);

  const position = useMemo(() => {
    if (!selection) return null;
    const sym = selection.symbol.toUpperCase();
    const rows = (positions ?? []).map(normalizePosition);
    return rows.find((p) => p.symbol.toUpperCase() === sym) ?? null;
  }, [positions, selection]);

  // ----------------------------------------------------------- validation
  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    const qty = Number(ticket.quantity);
    if (!Number.isInteger(qty) || qty < 1) errors.quantity = 'Quantity must be a whole number of at least 1';
    if (needsPrice && !(num(ticket.price) ?? 0 > 0)) errors.limitPrice = 'Enter a positive limit price';
    if (needsTrigger && !(num(ticket.triggerPrice) ?? 0 > 0)) errors.triggerPrice = 'Enter a positive trigger price';

    const price = refPrice ?? 0;
    const orderValue = Number.isInteger(qty) && qty > 0 && price > 0 ? qty * price : null;

    const serverMargin = marginPreview?.required ?? null;
    const serverKnown = serverMargin != null && Number.isFinite(serverMargin) && serverMargin >= 0;
    const localMargin = perShare != null && perShare > 0 && Number.isInteger(qty) && qty > 0 ? perShare * qty : null;
    const required = serverKnown ? serverMargin : localMargin;
    const marginSource: 'server' | 'estimate' | null = serverKnown ? 'server' : localMargin != null ? 'estimate' : null;

    const available = funds?.availableMargin ?? null;
    return {
      errors,
      valid: Object.keys(errors).length === 0,
      qty: Number.isInteger(qty) && qty > 0 ? qty : 0,
      orderValue,
      requiredMargin: required,
      marginSource,
      perShare,
      availableMargin: available,
      remainingMargin: required != null && available != null ? available - required : null,
      shortfall: required != null && available != null && required > available,
    };
  }, [ticket, needsPrice, needsTrigger, refPrice, perShare, marginPreview, funds]);

  // ---------------------------------------------------------- order entry
  const updateTicket = useCallback((patch: Partial<TicketState>) => {
    setTicket((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleSelect = useCallback((sel: InstrumentSelection) => {
    const safe = sanitizeSelection(sel);
    setSelection(safe);
    setSeedQuote(safe);
    setShowConfirm(false);
    setExec(EMPTY_EXEC);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSeedQuote(null);
    setMarginPreview(null);
  }, []);

  const placeOrder = useCallback(async () => {
    if (!validation.valid || !selection) return;
    setPlacing(true);
    setShowConfirm(false);
    setExec({ phase: 'submitting', at: new Date().toISOString() });
    try {
      const price = needsPrice ? (num(ticket.price) ?? 0) : 0;
      const trigger = needsTrigger ? (num(ticket.triggerPrice) ?? 0) : 0;
      let result: any;
      if (isDemo) {
        let ltpValue = ltp ?? 0;
        if (!(ltpValue > 0) && selection.token) {
          try {
            const snap = await getMarketWatchSnapshotFallback(selection.token);
            if (snap != null) ltpValue = snap;
          } catch {
            /* keep 0 */
          }
        }
        if (ticket.orderType === 'MKT' && !(ltpValue > 0)) {
          setExec({
            phase: 'failed',
            message: `No live price for ${selection.symbol} yet — the feed has no tick for it. Nothing was placed.`,
            raw: { reason: 'LTP_UNAVAILABLE' },
          });
          setPlacing(false);
          setExecNonce((n) => n + 1);
          return;
        }
        result = await placeDemoOrder({
          symbol: selection.symbol,
          tradingSymbol: selection.tradingSymbol ?? selection.symbol,
          exchange: selection.exchange,
          exchangeSegment: selection.exchangeSegment ?? selection.exchange,
          token: selection.token,
          transactionType: ticket.side,
          product: ticket.product,
          orderType: ticket.orderType,
          quantity: Number(ticket.quantity),
          price,
          triggerPrice: trigger,
          validity: ticket.validity,
          ltp: ltpValue,
          amount: 0,
          lotSize,
          marginPerShare: perShare ?? 0,
        });
      } else {
        result = await placeTerminalOrder(mode, {
          exchange: selection.exchange,
          token: selection.token,
          symbol: selection.symbol,
          transaction_type: ticket.side,
          product: ticket.product,
          order_type: ticket.orderType,
          quantity: String(Number(ticket.quantity)),
          price: String(price),
          trigger_price: String(trigger),
          validity: ticket.validity,
          disclosed_quantity: '0',
          expected_ltp: ltp ?? 0,
        });
      }

      const placed = isDemo ? (result?.demoOrder ?? {}) : (result?.order ?? result?.data ?? {});
      const rawStatus = String(placed?.status ?? placed?.orderStatus ?? result?.status ?? '').toUpperCase().trim();
      const accepted = isDemo ? result?.data?.stat === 'Ok' || result?.accepted === true : result?.ok === true;
      const orderId = placed?.orderId ?? result?.data?.n_ord_no ?? result?.orderId ?? null;

      if (!accepted) {
        setExec({
          phase: 'failed',
          message: stringifyDetail(
            result?.data?.remarks ?? placed?.errorMessage ?? result?.detail ?? result?.error ?? 'Order was not accepted.',
          ),
          raw: result,
        });
      } else if (FILLED_STATUSES.has(rawStatus)) {
        setExec({
          phase: 'filled',
          status: rawStatus || 'COMPLETE',
          orderId,
          filledQuantity: placed?.filledQuantity ?? demoFilled(result) ?? validation.qty,
          averagePrice: num(placed?.averagePrice ?? demoAverage(result)),
          raw: result,
        });
        setPositionsNonce((n) => n + 1);
        setFundsNonce((n) => n + 1);
      } else {
        const waitingFor = needsPrice ? price : needsTrigger ? trigger : null;
        setExec({
          phase: 'pending',
          status: rawStatus || (needsPrice ? 'OPEN' : 'PENDING'),
          orderId,
          reason: stringifyDetail(
            placed?.remarks ??
              placed?.reason ??
              result?.data?.remarks ??
              (needsPrice
                ? 'Resting until the live LTP reaches the limit price.'
                : 'Waiting for the live LTP to trigger this order.'),
          ),
          waitingFor: waitingFor != null && waitingFor > 0 ? waitingFor : null,
          raw: result,
        });
        setPositionsNonce((n) => n + 1);
      }
    } catch (err: any) {
      setExec({
        phase: 'failed',
        message: stringifyDetail(err?.body?.detail ?? err?.message ?? 'Order request failed.'),
        raw: err ?? {},
      });
    } finally {
      setPlacing(false);
      setExecNonce((n) => n + 1);
    }
  }, [
    validation.valid,
    validation.qty,
    selection,
    isDemo,
    mode,
    ticket,
    needsPrice,
    needsTrigger,
    ltp,
    lotSize,
    perShare,
  ]);

  const confirmRequired = useCallback((side: 'BUY' | 'SELL') => {
    const c = getSettingsStore().getSettings().confirm;
    return side === 'BUY' ? c.confirmBuy : c.confirmSell;
  }, []);

  const isTouch = useTouchPointer();
  const useSlide = isTouch && confirmRequired(ticket.side);

  const requestPlace = useCallback(() => {
    if (!validation.valid || !selection) return;
    if (ticket.orderType === 'MKT' && !(refPrice ?? 0 > 0)) return;
    if (confirmRequired(ticket.side)) {
      setShowConfirm(true);
      return;
    }
    void placeOrder();
  }, [validation.valid, selection, ticket.orderType, ticket.side, refPrice, confirmRequired, placeOrder]);

  const confirmPlace = useCallback(() => {
    if (!validation.valid || !selection) return;
    if (ticket.orderType === 'MKT' && !(refPrice ?? 0 > 0)) return;
    void placeOrder();
  }, [validation.valid, selection, ticket.orderType, refPrice, placeOrder]);

  const ackExec = useCallback(() => setExec(EMPTY_EXEC), []);

  // -------------------------------------------------------------- basket
  const addToBasket = useCallback(() => {
    if (!selection || !validation.valid) return;
    const legs = [
      ...basketLegs,
      {
        id: `${selection.symbol}-${Date.now()}`,
        selection,
        ticket: { ...ticket },
        addedAt: Date.now(),
      },
    ];
    setBasketLegs(legs);
    setBasketDraft({
      name: basketName,
      legs: legs.map((l) => ({
        symbol: l.selection.symbol,
        token: l.selection.token,
        exchange: l.selection.exchange,
        side: l.ticket.side,
        product: l.ticket.product,
        orderType: l.ticket.orderType,
        quantity: l.ticket.quantity,
        price: l.ticket.price,
        triggerPrice: l.ticket.triggerPrice,
      })),
    });
  }, [basketLegs, basketName, selection, ticket, validation.valid]);

  const removeLeg = useCallback((id: string) => {
    setBasketLegs((prev) => prev.filter((l) => l.id !== id));
  }, []);

  const clearBasket = useCallback(() => {
    setBasketLegs([]);
    setBasketDraft(null);
  }, []);

  // --------------------------------------------------------------- header
  const marketStatus = String(systemMarket?.market_status ?? '');
  const marketClosed =
    marketStatus === 'CLOSED' ||
    marketStatus === 'MARKET_CLOSED' ||
    marketStatus === 'POST_CLOSE' ||
    Boolean(systemMarket?.is_weekend) ||
    Boolean(systemMarket?.is_exchange_holiday);

  const armedTrigger = useMemo(
    () => triggers.find((t) => t.status === 'ARMED' && String(t.token) === token) ?? null,
    [triggers, token],
  );

  const engineIds = ['risk_engine', 'search_engine', 'order_engine', 'storage_engine'] as const;
  const engineOk = engineIds.filter((id) => {
    const e = (engines as Record<string, any>)[id];
    if (!e) return false;
    const h = String(e.health ?? e.state ?? '').toUpperCase();
    return h === 'HEALTHY' || h === 'RUNNING';
  }).length;

  const canPlace = !placing && validation.valid && !!selection && (ticket.orderType !== 'MKT' || (refPrice ?? 0) > 0);
  const errors = Object.values(validation.errors);

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-3 pb-28 md:pb-4">
      <TerminalRail
        caps={caps}
        capsSource={capsSource}
        sessionActive={sessionActive}
        marketStatus={marketStatus}
        marketClosed={marketClosed}
        feedState={feedState}
        engineOk={engineOk}
        engineTotal={engineIds.length}
        enginesConnected={enginesConnected}
      />

      <SafeRegion label="Search" resetKey={mode}>
        <div className="sticky top-0 z-30 -mx-3 border-b border-border/50 bg-background/95 px-3 py-2 backdrop-blur md:-mx-6 md:px-6">
          <InstrumentSearch
            onSelect={handleSelect}
            selectedSymbol={symbol}
            selectedSelection={selection}
            onClear={clearSelection}
            disabled={placing}
          />
        </div>
      </SafeRegion>

      {selection ? (
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="flex min-w-0 flex-col gap-3">
            <SafeRegion label="Quote" resetKey={`${token}|${symbol}`}>
              <QuoteHeader selection={selection} quote={quote} currency={unit} />
            </SafeRegion>

            <SafeRegion label="Order ticket" resetKey={`${token}|${ticket.side}`}>
              <section
                className={cn(
                  'overflow-hidden rounded-xl border bg-card shadow-soft',
                  ticket.side === 'BUY' ? 'border-success/40' : 'border-destructive/40',
                )}
              >
                {!sessionActive && !isDemo ? (
                  authResolved ? (
                    <AuthGate terminal={terminal} onAuthenticated={() => setLoggedIn(true)} />
                  ) : (
                    <p className="flex items-center gap-2 p-4 text-[13px] text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Connecting trading session…
                    </p>
                  )
                ) : (
                  <OrderTicketCard
                    caps={caps}
                    ticket={ticket}
                    onChange={(next) => {
                      setTicket(next);
                      if (next.orderType === 'MKT') updateTicket({ price: '' });
                    }}
                    quote={quote}
                    selection={selection}
                    lotSize={lotSize}
                    perShare={perShare}
                    disabled={placing}
                  />
                )}

                {errors.length > 0 && (
                  <div className="mx-3 mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] font-medium text-destructive">
                    {errors.map((m) => (
                      <p key={m} className="flex items-center gap-1.5">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> {m}
                      </p>
                    ))}
                  </div>
                )}

                {validation.shortfall && (
                  <p className="mx-3 mb-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-[12px] font-semibold text-destructive">
                    Not enough available margin for this order.
                  </p>
                )}

                <MarginStrip
                  currency={unit}
                  required={validation.requiredMargin}
                  requiredSource={validation.marginSource}
                  available={validation.availableMargin}
                  remaining={validation.remainingMargin}
                  orderValue={validation.orderValue}
                />

                <ExecutionPanel exec={exec} execNonce={execNonce} onAck={ackExec} />
              </section>
            </SafeRegion>
          </div>

          <SafeRegion label="Inspector" resetKey={`${token}|${ticket.side}`}>
            <TradeInspector
              caps={caps}
              mode={mode}
              terminal={terminal}
              selection={selection}
              ticket={ticket}
              quote={quote}
              precheck={precheck}
              checking={checking}
              marginMessage={marginPreview?.message ?? null}
              position={position}
              basketLegs={basketLegs}
              basketName={basketName}
              onBasketName={setBasketName}
              onAddToBasket={addToBasket}
              onRemoveLeg={removeLeg}
              onClearBasket={clearBasket}
              armedTrigger={armedTrigger}
              currency={unit}
              sessionActive={sessionActive}
            />
          </SafeRegion>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/50 px-6 py-14 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
            <SearchIcon className="h-5 w-5" />
          </span>
          <p className="text-[15px] font-semibold">Pick a stock to start</p>
          <p className="max-w-sm text-[13px] text-muted-foreground">
            Search above — the order ticket, the live price and the risk verdict open here the moment
            you select an instrument.
          </p>
        </div>
      )}

      {selection && (
        <>
          {/* Broker routing indicator — explicit about where the order lands. */}
          <SafeRegion label="Broker route" resetKey={mode}>
            <div
              className={cn(
                'rounded-xl border px-3 py-2.5 flex items-center gap-2 text-[12px]',
                isDemo
                  ? 'border-warning/30 bg-warning/10 text-warning'
                  : 'border-success/30 bg-success/10 text-success',
              )}
            >
              {isDemo ? (
                <>
                  <Monitor className="h-4 w-4 shrink-0" />
                  <span className="font-semibold">Orders route to Dummy Mode (paper trading)</span>
                  <span className="ml-auto text-xs font-semibold opacity-70">Not a real broker</span>
                </>
              ) : (
                <>
                  <Building2 className="h-4 w-4 shrink-0" />
                  <span className="font-semibold">Orders route to {caps.name} (real broker)</span>
                  <span className="ml-auto text-xs font-semibold opacity-70">
                    {sessionActive ? 'Session live' : 'Session required'}
                  </span>
                </>
              )}
            </div>
          </SafeRegion>

          <SafeRegion label="Action bar" resetKey={`${token}|${ticket.side}`}>
            <OrderActions
            side={ticket.side}
            symbol={selection.tradingSymbol || selection.symbol}
            disabled={!canPlace}
            placing={placing}
            swipe={useSlide}
            onConfirm={useSlide ? confirmPlace : requestPlace}
            summary={{
              orderType: ticket.orderType,
              product: ticket.product,
              validity: ticket.validity,
              quantity: validation.valid ? validation.qty : null,
              limit: needsPrice ? (num(ticket.price) ?? null) : null,
              margin: validation.requiredMargin,
              ltp,
              currency: unit,
            }}
            onFlip={() => updateTicket({ side: ticket.side === 'BUY' ? 'SELL' : 'BUY' })}
          />
        </SafeRegion>
        </>
      )}

      {showConfirm && selection && (
        <SafeRegion label="Confirm dialog" resetKey={`${token}|${ticket.side}`}>
          <ConfirmOrderDialog
            selection={selection}
            ticket={ticket}
            quote={quote}
            currency={unit}
            requiredMargin={validation.requiredMargin}
            orderValue={validation.orderValue}
            placing={placing}
            onCancel={() => setShowConfirm(false)}
            onConfirm={confirmPlace}
          />
        </SafeRegion>
      )}
    </div>
  );
}

/** Fallback price pull for the paper engine when no tick has arrived yet. */
async function getMarketWatchSnapshotFallback(token: string): Promise<number | null> {
  const { getMarketWatchTickSnapshot } = await import('@/lib/api');
  const res = await getMarketWatchTickSnapshot([token]);
  const row = res?.rows?.[String(token)];
  const v = num(row?.ltp);
  return v != null && v > 0 ? v : null;
}

function demoFilled(result: any): number | null {
  const o = result?.demoOrder ?? {};
  return num(o.filledQuantity ?? o.quantity);
}

function demoAverage(result: any): number | null {
  const o = result?.demoOrder ?? {};
  return num(o.averagePrice ?? o.filledPrice);
}
