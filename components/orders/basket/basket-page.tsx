'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus, Trash2, Play, Save, ScrollText, ChevronDown, ChevronUp,
  Eye, Loader2, Package, Clock, TrendingUp, TrendingDown, Shield,
  Info, AlertTriangle, CheckCircle2, XCircle, BarChart3,
  IndianRupee, Activity, Target, Zap, ArrowLeft, History,
  Copy, Calendar, RefreshCw, Search, X, Check, AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader, StatusBadge, EmptyState } from '@/components/design-system';
import { getBaskets, createBasket, updateBasket, deleteBasket, pushBasket, getNotifications, type Basket } from '@/lib/api';
import { takeBasketDraft } from '@/lib/basket-draft';
import { getTerminalPositions, getTerminalAccount, getTerminalMargin, getTerminalQuote, isAuthenticated, riskPrecheck, toTerminalId, getTerminalOrders } from '@/lib/terminal-service';
import { TradingService } from '@/lib/trading-service';
import { getSettingsStore, useAccountMode } from '@/lib/settings-store';
import { calculateCharges } from '@/lib/charge-engine';
import { capsFor, type TradeCapabilities } from '@/components/orders/trade/capabilities';
import { VALIDITIES } from '@/components/orders/trade/lifecycle';
import { InstrumentSearch } from '@/components/trading/instrument-search';
import { useToast } from '@/hooks/use-toast';
import { subscribeTicks } from '@/lib/shared-sse';
import type { InstrumentSelection } from '@/components/orders/trade/types';
import type { BasketExecResult, BasketExecState } from '@/components/orders/basket/types';
import dynamic from 'next/dynamic';

const BasketExecutionState = dynamic(() => import('./basket-execution').then((m) => ({ default: m.BasketExecutionState })), { ssr: false });

const inputCls =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm tabular-nums outline-none transition-colors focus:border-primary/60 focus:ring-2 focus:ring-primary/25 disabled:opacity-60 disabled:cursor-not-allowed';

const needsPrice = (o: string): boolean => o === 'L' || o === 'SL';
const needsTrigger = (o: string): boolean => o === 'SL' || o === 'SL-M';

function formatINR(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);
}
function formatINR2(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}
function statusTone(s: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const t = (s || '').toUpperCase();
  if (t === 'FILLED' || t === 'COMPLETED' || t === 'EXECUTED' || t === 'ACCEPTED') return 'success';
  if (t === 'PENDING' || t === 'PARTIALLY_FILLED' || t === 'PARTIAL' || t === 'EXECUTING') return 'warning';
  if (t === 'SUBMITTED' || t === 'OPEN') return 'info';
  if (t === 'REJECTED' || t === 'FAILED') return 'danger';
  if (t === 'CANCELLED' || t === 'DRAFT' || t === 'EXPIRED') return 'neutral';
  return 'neutral';
}
function orderStatusTone(s: string): string {
  const t = (s || '').toUpperCase();
  if (t === 'FILLED') return 'bg-success/15 text-success border-success/30';
  if (t === 'PARTIALLY_FILLED') return 'bg-warning/15 text-warning border-warning/30';
  if (t === 'REJECTED' || t === 'FAILED') return 'bg-destructive/15 text-destructive border-destructive/30';
  if (t === 'CANCELLED') return 'bg-muted/20 text-muted-foreground border-muted/30';
  if (t === 'OPEN') return 'bg-info/15 text-info border-info/30';
  if (t === 'PENDING' || t === 'SUBMITTED' || t === 'ACCEPTED') return 'bg-info/10 text-info border-info/20';
  if (t === 'DRAFT') return 'bg-muted/10 text-muted-foreground border-muted/20';
  return 'bg-muted/10 text-muted-foreground border-muted/20';
}
function isBasketExpired(b: Basket): boolean {
  const e = (b.expiry || '').toLowerCase();
  if (!e || e === 'n/a') return false;
  if (b.status?.toLowerCase() === 'expired') return true;
  // Today expires at EOD IST; This Week / Month not auto-expired without date; treat as not expired for now
  if (e === 'today') {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    // Expire after 15:30 IST (market close)
    return ist.getHours() > 15 || (ist.getHours() === 15 && ist.getMinutes() > 30);
  }
  return false;
}

function seedLeg(caps: TradeCapabilities, over: Record<string, any> = {}): Record<string, any> {
  return {
    key: `leg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    instrument: over.instrument || { symbol: '', token: '', exchange: 'nse_cm' },
    side: over.side || 'BUY',
    product: over.product || (caps.products[0] ?? 'MIS'),
    orderType: over.orderType || 'MKT',
    quantity: over.quantity || '1',
    price: over.price || '',
    triggerPrice: over.triggerPrice || '',
    validity: over.validity || 'DAY',
  };
}

/** Composer leg → the stored `BasketOrder` wire shape (camelCase).
 *  The backend validates these exact field names; sending snake_case silently
 *  dropped side / order type / trigger and turned a SELL limit into a BUY
 *  market order.
 *
 *  `expectedLtp` carries the REAL quote the page already holds for this leg so
 *  a price-less engine (the Dummy paper engine) can price it. It is only sent
 *  when a live number exists — a market leg with no quote is stored as 0 and
 *  rejected honestly at execution instead of being filled at a made-up price. */
function legToOrder(l: Record<string, any>, ltp?: number | null): Record<string, any> {
  const live = Number(ltp ?? l?.instrument?.ltp ?? 0) || 0;
  return {
    exchange: l.instrument.exchange ?? 'nse_cm',
    token: l.instrument.token ?? '',
    symbol: l.instrument.symbol,
    transactionType: l.side,
    product: l.product,
    orderType: l.orderType,
    quantity: String(Number(l.quantity)),
    price: String(needsPrice(l.orderType) ? Number(l.price) : 0),
    triggerPrice: String(needsTrigger(l.orderType) ? Number(l.triggerPrice) : 0),
    expectedLtp: String(live),
  };
}

/** Defensive normaliser: the backend returns the full `BasketExecResult`
 *  contract, but an error envelope or an older response must still render
 *  honestly instead of every leg falling through to a red "NOT ACCEPTED". */
function normalizeExecResults(raw: any): BasketExecResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any, i: number) => {
    const status = r?.status == null ? null : String(r.status);
    const upper = String(status ?? '').toUpperCase();
    const cancelled = r?.error === 'cancelOnFill' || upper === 'CANCELLED';
    const filled = upper === 'EXECUTED' || upper === 'FILLED' || upper === 'ACCEPTED';
    return {
      index: typeof r?.index === 'number' ? r.index : i,
      symbol: String(r?.symbol ?? ''),
      accepted: typeof r?.accepted === 'boolean' ? r.accepted : filled,
      orderId: r?.orderId == null || r.orderId === '' ? null : String(r.orderId),
      status,
      error: r?.error == null || r.error === '' ? null : String(r.error),
      raw: (r?.raw ?? r ?? {}) as Record<string, any>,
    };
  });
}

// ---- leg status (the backend writes executed/failed/cancelled, brokers write
// FILLED/REJECTED) — always compared case-insensitively so the counters on this
// page can never read "0 executed" right after a successful push. ----
const legStatus = (o: any): string => String(o?.status ?? '').toUpperCase();
const legIsExecuted = (o: any) => ['FILLED', 'PARTIALLY_FILLED', 'EXECUTED', 'ACCEPTED'].includes(legStatus(o));
const legIsPending = (o: any) => ['PENDING', 'SUBMITTED', 'OPEN'].includes(legStatus(o));
const legIsRejected = (o: any) => ['REJECTED', 'FAILED'].includes(legStatus(o));
const legIsCancelled = (o: any) => legStatus(o) === 'CANCELLED';

/** Basket states that mean "not running any more". */
const CLOSED_BASKET_STATUSES = new Set(['draft', 'completed', 'partial', 'failed', 'cancelled', 'expired']);

function isValidLeg(l: Record<string, any>): boolean {
  const q = Number(l.quantity);
  return (
    Boolean(l.instrument?.symbol) &&
    Number.isInteger(q) && q >= 1 &&
    (!needsPrice(l.orderType) || Number(l.price) > 0) &&
    (!needsTrigger(l.orderType) || Number(l.triggerPrice) > 0)
  );
}

function calcOrderValue(l: Record<string, any>, priceOverride?: number): number {
  const q = Number(l.quantity) || 0;
  const p = priceOverride ?? (needsPrice(l.orderType) ? (Number(l.price) || 0) : 0);
  return q * p;
}

function calcCharges(l: Record<string, any>, priceOverride?: number): Record<string, number> {
  const q = Number(l.quantity) || 0;
  const p = priceOverride ?? (needsPrice(l.orderType) ? (Number(l.price) || 0) : 0);
  try {
    const c = calculateCharges({
      side: l.side === 'SELL' ? 'SELL' : 'BUY',
      quantity: q,
      price: p,
      product: l.product,
      exchange: l.instrument.exchange || 'nse_cm',
      timestamp: new Date(),
    }) as unknown as Record<string, number>;
    return c;
  } catch {
    return { brokerage: 0, stt: 0, exchangeTransactionCharges: 0, sebiCharges: 0, stampDuty: 0, gst: 0, totalCharges: 0 };
  }
}

export function BasketPage({ mode, preloadedLoggedIn }: { mode: any; preloadedLoggedIn?: boolean }) {
  const terminal = toTerminalId(mode);
  const caps = useMemo<TradeCapabilities>(() => capsFor(terminal), [terminal]);
  // The Dummy paper engine needs no operator JWT (same rule as the Trade page):
  // a demo session is a session, so account / funds / positions / LTP / risk
  // prechecks all run instead of sitting behind a "Sign in" wall.
  const isDemo = mode === 'dummy';
  const accountMode = useAccountMode();
  const { toast } = useToast();
  const loggedIn = Boolean(preloadedLoggedIn) || isAuthenticated() || isDemo;

  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newMaxOrders, setNewMaxOrders] = useState('');
  const [newAllocation, setNewAllocation] = useState('');
  const [newExpiry, setNewExpiry] = useState('Today');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [legs, setLegs] = useState<Record<string, any>[]>([]);
  const [prechecks, setPrechecks] = useState<Record<string, any>>({});
  const [placing, setPlacing] = useState(false);
  const [execState, setExecState] = useState<BasketExecState>({ phase: 'idle' });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [positions, setPositions] = useState<any[] | null>(null);
  const [account, setAccount] = useState<any>(null);
  const [funds, setFunds] = useState<any>(null);
  const [quoteMap, setQuoteMap] = useState<Record<string, any>>({});
  const [ltpLoading, setLtpLoading] = useState(false);
  const [notifications, setNotifications] = useState<any[] | null>(null);
  const [addOrderOpen, setAddOrderOpen] = useState(false);
  const [addOrderSymbol, setAddOrderSymbol] = useState<string | null>(null);
  const [addOrderLeg, setAddOrderLeg] = useState<Record<string, any> | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Record<string, any> | null>(null);
  const [editingBasket, setEditingBasket] = useState<Basket | null>(null);
  const [editName, setEditName] = useState('');
  const [editAllocation, setEditAllocation] = useState('');
  const [editExpiry, setEditExpiry] = useState('Today');

  const keyCounter = useRef(0);

  // ---- fetch baskets ----
  const refreshBaskets = useCallback(async () => {
    try {
      const res = await getBaskets();
      setBaskets(res?.data ?? []);
    } catch {
      setBaskets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refreshBaskets(); }, [refreshBaskets]);

  // ---- basket draft carried over from the Trade page (one-shot) ----
  useEffect(() => {
    const draft = takeBasketDraft();
    if (!draft?.legs?.length) return;
    setLegs(draft.legs.map((leg) => seedLeg(caps, {
      instrument: { symbol: leg.symbol, token: leg.token, exchange: leg.exchange },
      side: leg.side,
      product: leg.product,
      orderType: leg.orderType,
      quantity: leg.quantity,
      price: leg.price,
      triggerPrice: leg.triggerPrice,
    })));
    const draftName = (draft.name || '').trim();
    if (draftName) setNewName(draftName);
    toast({
      title: 'Draft loaded from Trade',
      description: `${draft.legs.length} leg${draft.legs.length === 1 ? '' : 's'} carried over${draftName ? ` into “${draftName}”` : ''}.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps]);

  // ---- fetch positions, account, funds ----
  useEffect(() => {
    if (!loggedIn) return;
    (async () => {
      try {
        const p = await getTerminalPositions(terminal);
        setPositions(Array.isArray(p?.data) ? p.data : Array.isArray(p) ? p : null);
      } catch { setPositions(null); }
    })();
    (async () => {
      try {
        const a = await getTerminalAccount(terminal);
        setAccount(a?.data ?? a);
      } catch { setAccount(null); }
    })();
    (async () => {
      try {
        const f = await TradingService.getFunds();
        setFunds({ availableMargin: f?.availableMargin || 0, usedMargin: f?.usedMargin || 0 });
      } catch { setFunds(null); }
    })();
  }, [loggedIn, terminal]);

  // ---- notifications ----
  const fetchNotifications = useCallback(async () => {
    try {
      const n = await getNotifications();
      setNotifications(n?.data ?? []);
    } catch { setNotifications([]); }
  }, []);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // ---- live LTP via the SHARED browser tick stream ----
  useEffect(() => {
    if (!loggedIn) return;
    // One SSE session for the whole app; this page only registers a listener.
    return subscribeTicks((t) => {
      try {
        if (t.ltp == null || t.ltp === 0) return;
        const sym = t.symbol ? String(t.symbol).toUpperCase() : '';
        const token = t.instrumentToken != null ? String(t.instrumentToken) : '';
        setQuoteMap((prev) => ({ ...prev, [sym]: { ltp: Number(t.ltp), change: t.change ?? 0, changePct: t.change_pct ?? 0, ts: Date.now() } }));
        if (token) setQuoteMap((prev) => ({ ...prev, [token]: { ltp: Number(t.ltp), change: t.change ?? 0, changePct: t.change_pct ?? 0, ts: Date.now() } }));
      } catch { /* ignore */ }
    });
  }, [loggedIn]);

  // ---- legs management ----
  const addLeg = (instrument: InstrumentSelection) => {
    const maxOrders = parseInt(newMaxOrders) || 0;
    if (maxOrders > 0 && legs.length >= maxOrders) {
      toast({ title: 'Maximum order limit reached', description: `Basket allows max ${maxOrders} orders`, variant: 'destructive' });
      return;
    }
    // allocation check will be validated on create; for live legs we allow but will warn
    setLegs((prev) => [...prev, seedLeg(caps, { instrument })]);
    keyCounter.current++;
  };

  const canAddLegToExisting = (basket: Basket, newLegValue: number): boolean => {
    const maxOrders = (basket as any).maxOrders ?? 20;
    const allocated = (basket as any).allocatedAmount ?? 0;
    const currentOrders = basket.orders?.length ?? 0;
    if (maxOrders > 0 && currentOrders >= maxOrders) return false;
    if (allocated > 0) {
      const used = basket.orders?.reduce((s: number, o: any) => s + (Number(o.quantity) || 0) * (Number(o.price) || 0), 0) ?? 0;
      if (used + newLegValue > allocated) return false;
    }
    return true;
  };

  const patchLeg = (key: string, patch: Record<string, any>) => {
    setLegs((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const removeLeg = (key: string) => setLegs((prev) => prev.filter((l) => l.key !== key));

  // ---- risk precheck ----
  useEffect(() => {
    if (legs.length === 0) { setPrechecks({}); return; }
    let cancelled = false;
    let timer: number | null = null;
    setPrechecks((prev) => {
      const next = { ...prev };
      for (const l of legs) {
        next[l.key] = { key: l.key, kind: 'UNKNOWN', label: isValidLeg(l) ? 'queued…' : 'complete the leg fields', status: 'pending' };
      }
      return next;
    });
    timer = window.setTimeout(async () => {
      if (!loggedIn) {
        setPrechecks((prev) => {
          const next = { ...prev };
          for (const l of legs) next[l.key] = { key: l.key, kind: 'EMERGENCY_BLOCK', label: 'Sign in to unlock trading.', status: 'done' };
          return next;
        });
        return;
      }
      const valid = legs.filter(isValidLeg);
      const results = await Promise.all(
        valid.map(async (l) => {
          try {
            const res = await riskPrecheck({
              terminal, symbol: l.instrument.symbol, token: l.instrument.token ?? '',
              exchange: l.instrument.exchange ?? 'nse_cm',
              transaction_type: l.side, product: l.product, order_type: l.orderType,
              quantity: String(Number(l.quantity)),
              price: String(needsPrice(l.orderType) ? Number(l.price) : 0),
              trigger_price: String(needsTrigger(l.orderType) ? Number(l.triggerPrice) : 0),
              expected_ltp: quoteMap[l.instrument.symbol]?.ltp ?? 0,
            });
            if (cancelled) return { key: l.key, kind: 'UNKNOWN', label: typeof res?.error === 'string' ? res.error : 'Risk service unavailable.', status: 'done' };
            const d = res.data ?? {};
            return d.accepted === true
              ? { key: l.key, kind: 'PASS', label: 'passes active risk policy', status: 'done' }
              : { key: l.key, kind: 'BLOCK', label: 'blocked by the Risk Engine', reasons: Array.isArray(d.reasons) ? d.reasons : [], status: 'done' };
          } catch { return { key: l.key, kind: 'UNKNOWN', label: 'precheck error', status: 'done' }; }
        }),
      );
      if (cancelled) return;
      setPrechecks((prev) => {
        const next = { ...prev };
        for (const r of results) if (r) next[r.key] = r;
        return next;
      });
    }, 450);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [legs, terminal, loggedIn, quoteMap]);

  // ---- basket CRUD ----
  const handleCreateBasket = async () => {
    if (!newName.trim() || legs.length === 0) return;
    try {
      setCreating(true);
      const maxOrders = parseInt(newMaxOrders) || legs.length;
      const allocation = Number(newAllocation) || 0;
      await createBasket({
        name: newName.trim(),
        orders: legs.map((l) => legToOrder(l, quoteMap[String(l.instrument?.symbol ?? '').toUpperCase()]?.ltp)),
        cancelOnFill: true,
        maxOrders,
        allocatedAmount: allocation,
        expiry: newExpiry,
      });
      setNewName(''); setNewMaxOrders(''); setNewAllocation('');
      setShowCreateDialog(false);
      setLegs([]);
      await refreshBaskets();
      toast({ title: 'Basket created', description: `${newName.trim()} has been created.` });
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message ?? 'Failed to create basket', variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const handleExecute = async (id: string) => {
    try {
      setExecutingId(id);
      setExecState({ phase: 'placing', at: new Date().toISOString() });
      // `terminal` pins the broker: legs go to Dummy while the page is in
      // Dummy and to Kotak while it is in Kotak, never to the other one.
      const res = await pushBasket(id, terminal);
      const results = normalizeExecResults(res?.results);
      setExecState({ phase: 'done', results });
      const accepted = results.filter((r) => r.accepted).length;
      const ranOn = res?.terminal ?? terminal;
      if (accepted > 0) {
        toast({
          title: `${accepted}/${results.length} legs placed on ${ranOn}`,
          description: `Sent through the ${caps.name} order engine (Risk → Audit → ${caps.name}).`,
        });
      } else {
        toast({
          title: 'No leg was accepted',
          description: 'Every leg was rejected — see the per-leg reason below.',
          variant: 'destructive',
        });
      }
      await refreshBaskets();
    } catch (err: any) {
      const detail = err?.body?.detail ?? null;
      const results = normalizeExecResults(detail?.results ?? null);
      if (results.length > 0) {
        setExecState({ phase: 'done', results });
      } else {
        setExecState({ phase: 'failed', message: typeof err?.message === 'string' ? err.message : 'Execution failed.' });
      }
      toast({ title: 'Execution failed', description: err?.message ?? 'Basket execution failed.', variant: 'destructive' });
    } finally {
      setExecutingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteBasket(id);
      await refreshBaskets();
      toast({ title: 'Basket deleted' });
    } catch { /* ignore */ }
    setDeleteConfirmId(null);
  };

  const handleDuplicate = async (b: Basket) => {
    try {
      await createBasket({
        name: `${b.name} (Copy)`,
        orders: (b.orders ?? []).map((o) => ({ ...o })),
        cancelOnFill: b.cancelOnFill,
        status: 'draft',
        // The copy keeps the same policy — a duplicate that silently dropped
        // maxOrders / allocation / expiry was not a duplicate.
        maxOrders: b.maxOrders ?? null,
        allocatedAmount: b.allocatedAmount ?? null,
        expiry: b.expiry ?? null,
      });
      await refreshBaskets();
      toast({ title: 'Basket duplicated' });
    } catch { /* ignore */ }
  };

  const handleEditBasket = async () => {
    if (!editingBasket || !editName.trim()) return;
    try {
      const allocation = Number(editAllocation) || 0;
      await updateBasket(editingBasket._id, { name: editName.trim(), allocatedAmount: allocation, expiry: editExpiry });
      setEditingBasket(null);
      await refreshBaskets();
      toast({ title: 'Basket updated' });
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message ?? 'Failed to update basket', variant: 'destructive' });
    }
  };

  const handleAddLegToBasket = async (basketId: string, leg: Record<string, any>) => {
    const b = baskets.find((x) => x._id === basketId);
    if (!b) return;
    const val = calcOrderValue(leg);
    if (!canAddLegToExisting(b, val)) {
      const maxOrders = (b as any).maxOrders ?? 0;
      if (maxOrders > 0 && (b.orders?.length ?? 0) >= maxOrders) {
        toast({ title: 'Maximum order limit reached', description: `Basket allows max ${maxOrders} orders`, variant: 'destructive' });
        return;
      }
      toast({ title: 'Allocation exceeded', description: 'Order value exceeds remaining allocation', variant: 'destructive' });
      return;
    }
    try {
      // Both halves are already in the stored wire shape: existing legs come
      // back from the API as camelCase, and legToOrder emits camelCase too.
      await updateBasket(basketId, {
        orders: [...(b.orders ?? []), legToOrder(leg, quoteMap[String(leg.instrument?.symbol ?? '').toUpperCase()]?.ltp)],
      });
      await refreshBaskets();
      toast({ title: 'Order added to basket' });
      setAddOrderLeg(null);
      setAddOrderSymbol(null);
    } catch (err: any) {
      toast({ title: 'Failed to add order', description: err?.message ?? 'Could not add order to basket', variant: 'destructive' });
    }
  };

  const handleRemoveOrderFromBasket = async (basketId: string, orderIndex: number) => {
    const b = baskets.find((x) => x._id === basketId);
    if (!b) return;
    if (b.status === 'executing' || b.status === 'running') {
      toast({ title: 'Cannot remove order', description: 'Basket is executing', variant: 'destructive' });
      return;
    }
    try {
      const newOrders = (b.orders ?? []).filter((_: any, i: number) => i !== orderIndex);
      await updateBasket(basketId, { orders: newOrders });
      await refreshBaskets();
      toast({ title: 'Order removed' });
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message ?? 'Failed to remove order', variant: 'destructive' });
    }
  };

  // ---- derived ----
  const isBasketOpen = (b: Basket) => !CLOSED_BASKET_STATUSES.has(String(b.status ?? '').toLowerCase());
  const activeBaskets = baskets.filter(isBasketOpen);
  const totalOrders = baskets.reduce((s, b) => s + (b.orders?.length ?? 0), 0);
  const pendingOrders = baskets.reduce((s, b) => s + (b.orders?.filter(legIsPending).length ?? 0), 0);
  const executedOrders = baskets.reduce((s, b) => s + (b.orders?.filter(legIsExecuted).length ?? 0), 0);
  const totalAllocated = baskets.reduce((s, b) => (s + (Number(b.allocatedAmount) || 0)), 0);
  // Exposure: limit legs carry their own price, market legs need an LTP. A leg
  // with neither is UNKNOWN — it is excluded from the number and reported by
  // the label instead of being silently counted as ₹0.
  let unknownExposure = 0;
  const legExposure = (o: any): number | null => {
    const q = Number(o.quantity) || 0;
    const price = Number(o.price) || Number(quoteMap[String(o.symbol ?? '').toUpperCase()]?.ltp) || 0;
    if (!(q > 0) || !(price > 0)) return null;
    return o.product === 'MIS' ? q * price * 0.2 : q * price;
  };
  const basketExposure = (orders: any[] | undefined): { value: number; unknown: number } => {
    let value = 0;
    let unknown = 0;
    for (const o of orders ?? []) {
      const e = legExposure(o);
      if (e == null) unknown += 1;
      else value += e;
    }
    return { value, unknown };
  };
  const totalExposure = baskets.reduce((s, b) => s + basketExposure(b.orders).value, 0);
  unknownExposure = baskets.reduce((s, b) => s + basketExposure(b.orders).unknown, 0);
  const exposureLabel = unknownExposure > 0
    ? (totalExposure > 0 ? `${formatINR(totalExposure)}+` : '—')
    : formatINR(totalExposure);
  /** Order value (qty × price, LTP for market legs) with the unknown count. */
  const basketValue = (orders: any[] | undefined): { value: number; unknown: number } => {
    let value = 0;
    let unknown = 0;
    for (const o of orders ?? []) {
      const q = Number(o.quantity) || 0;
      const price = Number(o.price) || Number(quoteMap[String(o.symbol ?? '').toUpperCase()]?.ltp) || 0;
      if (!(q > 0) || !(price > 0)) {
        unknown += 1;
        continue;
      }
      value += q * price;
    }
    return { value, unknown };
  };
  const labelAtMost = (value: number, unknown: number): string =>
    unknown > 0 ? `≤ ${formatINR(value)}` : formatINR(value);

  const allValid = legs.length > 0 && legs.every(isValidLeg);
  const allPass = allValid && legs.every((l) => prechecks[l.key]?.kind === 'PASS');
  const canPlace = loggedIn && allPass && !placing;
  /** Legs with no real quote behind them. The Dummy paper engine prices only
   *  from a live LTP, so these will be rejected at execution with "Market LTP
   *  unavailable". A real broker (Kotak) prices from its own feed, so this is
   *  reported rather than blocked. */
  const legsWithoutLtp = useMemo(
    () => legs.filter((l) => !(Number(l.instrument?.ltp) || Number(quoteMap[String(l.instrument?.symbol ?? '').toUpperCase()]?.ltp) > 0)).map((l) => l.instrument?.symbol),
    [legs, quoteMap],
  );

  // Composer totals. A market leg carries no price of its own, so it can only
  // be valued from a live LTP — with no LTP the amount is UNKNOWN and the
  // label reports that instead of rendering a fake ₹0.
  const legUnitPrice = (l: Record<string, any>): number =>
    needsPrice(l.orderType)
      ? Number(l.price) || 0
      : Number(quoteMap[String(l.instrument?.symbol ?? '').toUpperCase()]?.ltp) || 0;
  const composer = useMemo(() => {
    let value = 0;
    let charges = 0;
    let margin = 0;
    let unknown = 0;
    for (const l of legs) {
      const q = Number(l.quantity) || 0;
      const p = legUnitPrice(l);
      if (!(q > 0) || !(p > 0)) {
        unknown += 1;
        continue;
      }
      const val = q * p;
      value += val;
      margin += l.product === 'MIS' ? val * 0.2 : val;
      charges += calcCharges(l, p).totalCharges;
    }
    return { value, charges, margin, unknown };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, quoteMap]);
  const totalValue = composer.value;
  const totalCharges = composer.charges;
  const totalMargin = composer.margin;
  /** `₹1,234+` = at least this much (one leg still unpriced); `—` = nothing is priced. */
  const withUnknown = (v: number): string =>
    composer.unknown > 0 ? (v > 0 ? `${formatINR(v)}+` : '—') : formatINR(v);
  const totalValueLabel = withUnknown(totalValue);
  const totalChargesLabel = withUnknown(totalCharges);
  const totalMarginLabel = withUnknown(totalMargin);
  const availableMargin = funds?.availableMargin || account?.freeMargin || 0;
  const usedMargin = funds?.usedMargin || account?.usedMargin || 0;
  const remainingMargin = availableMargin - usedMargin;
  /** False until the Account/Margin engine actually answered — ₹0 is not an answer. */
  const fundsKnown = funds != null || account != null;

  const getQuote = (symbol: string): any => quoteMap[symbol?.toUpperCase()];

  return (
    <div className="space-y-5 pb-6">
      {/* ═══════ HEADER ═══════ */}
      <PageHeader title={`Basket Orders · ${caps.name}`}>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={loggedIn ? 'success' : 'warning'} label={loggedIn ? 'Session active' : 'No session'} />
          <StatusBadge status="info" label={`${caps.modeLabel} · ${caps.accountCurrency}`} />
          {accountMode === 'api' && <Badge className="bg-success/10 text-success border-success/30">● API MODE</Badge>}
        </div>
      </PageHeader>

      {/* Execution route — which broker every leg on this page is bound to.
          Shown because "my basket hit the wrong book" is otherwise invisible. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-xs">
        <div className="flex items-center gap-2">
          <Shield className={cn('h-4 w-4', loggedIn ? 'text-success' : 'text-destructive')} />
          <span className="font-semibold">{caps.name}</span>
          <span className="text-muted-foreground">order engine</span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span>Route:</span>
          <span className="font-mono font-semibold text-foreground">
            Risk → Audit → {caps.name}
          </span>
        </div>
        <Separator orientation="vertical" className="hidden h-4 sm:block" />
        <StatusBadge
          status={loggedIn ? 'success' : 'danger'}
          label={loggedIn ? `Connected to ${caps.name}` : `${caps.name} not connected`}
        />
        {!loggedIn && (
          <span className="text-muted-foreground">
            Connect this terminal before executing a basket.
          </span>
        )}
      </div>

      {/* Dummy Mode — replaces session required card */}
      {(mode === 'dummy' || caps.virtualCurrency) && (
        <div className="rounded-xl border border-purple/30 bg-gradient-to-br from-purple/10 via-purple/[0.04] to-transparent px-4 py-3.5 flex items-center gap-3 shadow-sm">
          <div className="h-9 w-9 rounded-xl bg-purple/15 border border-purple/20 flex items-center justify-center shrink-0">
            <Activity className="h-4 w-4 text-purple" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold tracking-tight text-purple flex items-center gap-2">● Dummy Mode — Virtual Trading <Badge className="bg-purple/15 text-purple border-purple/30 text-[9px] h-4 px-1.5">PAPER</Badge></div>
            <p className="text-xs font-medium text-muted-foreground">Paper execution via Dummy Engine · No broker funds · Real market LTP · Instant fills</p>
          </div>
          <div className="hidden sm:flex items-center gap-2 shrink-0">
            <span className="h-2 w-2 rounded-full bg-purple animate-pulse" />
            <span className="text-[11px] font-bold text-purple tracking-wider">VIRTUAL</span>
          </div>
        </div>
      )}
      {/* Basket / Order Details — always visible */}
      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5 bg-muted/10">
          <h3 className="text-xs font-bold uppercase tracking-widest text-foreground flex items-center gap-2"><Package className="h-3.5 w-3.5 text-primary" /> Basket Details</h3>
          <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">{baskets.length} baskets · {totalOrders} orders</span>
        </div>
        <div className="p-4 grid gap-4 md:grid-cols-3 text-xs leading-relaxed">
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">System</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Terminal</span><span className="font-bold text-foreground">{caps.name}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Mode</span><span className="font-bold">{caps.modeLabel}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Currency</span><span className="font-bold">{caps.accountCurrency}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Margin Preview</span><span className={cn('font-bold', caps.supportsMarginPreview ? 'text-success' : 'text-muted-foreground')}>{caps.supportsMarginPreview ? 'Supported' : 'Client estimate'}</span></div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Basket Overview</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Active</span><span className="font-bold text-foreground">{activeBaskets.length}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Total Orders</span><span className="font-bold text-foreground">{totalOrders}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Pending / Executed</span><span className="font-bold"><span className="text-warning">{pendingOrders}</span> / <span className="text-success">{executedOrders}</span></span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Exposure</span><span className="font-mono font-bold">{exposureLabel}</span></div>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-primary">Order Details</p>
            <div className="space-y-1.5 font-medium">
              <div className="flex justify-between"><span className="text-muted-foreground">Legs in composer</span><span className="font-bold text-foreground">{legs.length}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Total Value</span><span className="font-mono font-bold">{totalValueLabel}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Est. Charges</span><span className="font-mono font-bold">{totalChargesLabel}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Est. Margin</span><span className="font-mono font-bold">{totalMarginLabel}</span></div>
            </div>
          </div>
        </div>
        <div className="px-4 py-2.5 bg-muted/20 border-t border-border/50 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <Info className="h-3.5 w-3.5 text-info shrink-0" />
          <span>Tap any order row to view full detail — basket cards expand to show per-leg LTP, value, margin, charges, filled qty.</span>
        </div>
      </section>

      {/* ═══════ SUMMARY BAR ═══════ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Active Baskets', text: String(activeBaskets.length), icon: Package },
          { label: 'Total Orders', text: String(totalOrders), icon: BarChart3 },
          { label: 'Pending', text: String(pendingOrders), icon: Clock },
          { label: 'Executed', text: String(executedOrders), icon: CheckCircle2 },
          { label: 'Allocated', text: formatINR(totalAllocated), icon: IndianRupee },
          { label: 'Exposure', text: exposureLabel, icon: Shield },
        ].map((m) => (
          <div key={m.label} className="rounded-xl border border-border bg-card p-3 shadow-sm">
            <div className="flex items-center gap-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              <m.icon className="h-3 w-3" /> {m.label}
            </div>
            <div className="mt-1 text-xl font-bold font-mono tabular-nums truncate">{m.text}</div>
          </div>
        ))}
      </div>

      {/* ═══════ CREATE BASKET BUTTON ═══════ */}
      <div className="flex items-center justify-between">
        <div />
        <Button className="gap-2" onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4" /> Create Basket
        </Button>
      </div>

      {/* ═══════ BASKET LIST ═══════ */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : baskets.length === 0 ? (
        <EmptyState icon={Package} title="No baskets created yet" description="Create your first basket to group multiple orders." />
      ) : (
        <div className="space-y-3">
          {baskets.map((b) => {
            const expanded = expandedId === b._id;
            const isExecuting = executingId === b._id;
            const orders = b.orders ?? [];
            const executed = orders.filter(legIsExecuted).length;
            const pending = orders.filter(legIsPending).length;
            const rejected = orders.filter(legIsRejected).length;
            const cancelled = orders.filter(legIsCancelled).length;
            const basketVal = basketValue(orders);
            const totalVal = basketVal.value;
            const totalValLabel = labelAtMost(totalVal, basketVal.unknown);
            const basketMar = basketExposure(orders);
            const basketMarLabel = labelAtMost(basketMar.value, basketMar.unknown);
            const isExpired = b.status === 'expired' || b.status === 'EXPIRED';
            // A basket composed under one broker and executed while another is
            // active would silently land on the wrong book. Surfaced, not hidden.
            const boundTerminal = b.terminal ?? null;
            const terminalMismatch = boundTerminal != null && boundTerminal !== terminal;

            return (
              <Collapsible key={b._id} open={expanded} onOpenChange={() => setExpandedId(expanded ? null : b._id)}>
                <div className={cn('rounded-xl border overflow-hidden', isExpired ? 'border-destructive/30 bg-destructive/[0.03]' : 'border-border bg-card')}>
                  <CollapsibleTrigger asChild>
                    <button className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors" aria-label={`${b.name} details`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={cn('h-1.5 w-1.5 rounded-full shrink-0', isExpired ? 'bg-destructive' : b.status === 'active' || b.status === 'executing' ? 'bg-success animate-pulse' : 'bg-muted-foreground')} />
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold truncate">{b.name}</h3>
                          <p className="text-[10px] text-muted-foreground">{b.status?.toUpperCase()} · {orders.length} orders · Expires: {b.expiry ?? 'N/A'}</p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground/80">
                            {terminalMismatch ? (
                              <span className="text-warning">Composed on {boundTerminal} · will execute on {caps.name}</span>
                            ) : (
                              <>Broker: <span className="font-mono">{caps.name}</span>{boundTerminal ? ` (${boundTerminal})` : ''}</>
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right text-xs tabular-nums">
                          <div className="font-semibold">{executed}/{orders.length} done</div>
                          <div className="text-muted-foreground">{totalValLabel}</div>
                        </div>
                        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t border-border/50 px-4 py-3 space-y-3">
                      {/* Order summary */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="rounded-lg bg-muted/20 p-2"><span className="text-muted-foreground">Total</span><div className="font-semibold">{orders.length}</div></div>
                        <div className="rounded-lg bg-success/10 p-2"><span className="text-muted-foreground">Executed</span><div className="font-semibold text-success">{executed}</div></div>
                        <div className="rounded-lg bg-warning/10 p-2"><span className="text-muted-foreground">Pending</span><div className="font-semibold text-warning">{pending}</div></div>
                        <div className="rounded-lg bg-destructive/10 p-2"><span className="text-muted-foreground">Rejected</span><div className="font-semibold text-destructive">{rejected}</div></div>
                      </div>

                      {/* Progress */}
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className={cn('h-full rounded-full transition-all', executed > 0 ? 'bg-success' : 'bg-muted-foreground')} style={{ width: `${orders.length > 0 ? (executed / orders.length) * 100 : 0}%` }} />
                      </div>

                      {/* Allocation & Exposure */}
                      {((b as any).allocatedAmount != null || basketVal.unknown > 0 || totalVal > 0) && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                          <div className="rounded-lg border border-border/40 bg-muted/20 p-2">
                            <span className="text-muted-foreground">Allocated</span>
                            <div className="font-semibold font-mono">{(b as any).allocatedAmount != null ? formatINR((b as any).allocatedAmount) : '—'}</div>
                          </div>
                          <div className="rounded-lg border border-border/40 bg-muted/20 p-2">
                            <span className="text-muted-foreground">Used</span>
                            <div className="font-semibold font-mono">{totalValLabel}</div>
                          </div>
                          <div className="rounded-lg border border-border/40 bg-muted/20 p-2">
                            <span className="text-muted-foreground">Remaining</span>
                            <div className={cn('font-semibold font-mono', ((b as any).allocatedAmount != null && (b as any).allocatedAmount - totalVal < 0) ? 'text-destructive' : 'text-success')}>
                              {(b as any).allocatedAmount != null ? labelAtMost((b as any).allocatedAmount - totalVal, basketVal.unknown) : '—'}
                            </div>
                          </div>
                          <div className="rounded-lg border border-border/40 bg-muted/20 p-2">
                            <span className="text-muted-foreground">Exposure</span>
                            <div className="font-semibold font-mono">{basketMarLabel}</div>
                          </div>
                        </div>
                      )}

                      {/* Orders list */}
                      {orders.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Orders · {orders.length}</h4>
                            <span className="text-[10px] text-muted-foreground">▼ View Orders</span>
                          </div>
                          {orders.map((o: any, i: number) => {
                            const quote = getQuote(o.symbol);
                            const ltp = quote?.ltp;
                            const priceNum = Number(o.price) || 0;
                            const qtyNum = Number(o.quantity) || 0;
                            const effectivePrice = o.orderType === 'MKT' ? (ltp ?? priceNum) : priceNum;
                            const estimatedValue = qtyNum * effectivePrice;
                            const margin = o.product === 'MIS' ? estimatedValue * 0.2 : estimatedValue;
                            let chargesTotal = 0;
                            try {
                              const c = calculateCharges({ side: o.transactionType === 'SELL' ? 'SELL' : 'BUY', quantity: qtyNum, price: effectivePrice, product: o.product, exchange: o.exchange, timestamp: new Date() }) as unknown as Record<string, number>;
                              chargesTotal = c.totalCharges ?? 0;
                            } catch { chargesTotal = 0; }
                            const filledQty = o.filledQuantity ?? o.filled_quantity ?? null;
                            const fillPrice = o.avgPrice ?? o.averagePrice ?? o.fillPrice ?? null;
                            return (
                              <div key={i} onClick={() => setSelectedOrder({ ...o, basketId: b._id, basketName: b.name, index: i, ltp, estimatedValue, margin, chargesTotal, filledQty, fillPrice })} className="cursor-pointer hover:bg-muted/20 flex flex-col gap-2 px-3 py-2.5 rounded-xl border border-border/40 bg-muted/10 text-xs transition-colors">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-semibold truncate">{o.symbol}</span>
                                    <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-bold', o.transactionType === 'BUY' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')}>{o.transactionType}</span>
                                    <span className="text-[10px] text-muted-foreground">Qty {o.quantity}</span>
                                    <span className="text-[10px] text-muted-foreground">{o.orderType}</span>
                                    <span className="text-[10px] text-muted-foreground">{o.product}</span>
                                  </div>
                                  <StatusBadge status={statusTone(o.status)} label={o.status ?? 'PENDING'} />
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-[11px]">
                                  <div><span className="text-muted-foreground">LTP</span><div className="font-mono font-semibold">{ltp != null ? formatINR2(ltp) : '—'}</div></div>
                                  <div><span className="text-muted-foreground">Price</span><div className="font-mono font-semibold">{o.orderType === 'MKT' ? 'MKT' : formatINR2(priceNum)}</div></div>
                                  <div><span className="text-muted-foreground">Value</span><div className="font-mono font-semibold">{formatINR(estimatedValue)}</div></div>
                                  <div><span className="text-muted-foreground">Margin</span><div className="font-mono font-semibold">{formatINR(margin)}</div></div>
                                  <div><span className="text-muted-foreground">Charges</span><div className="font-mono font-semibold">{formatINR(chargesTotal)}</div></div>
                                  <div>
                                    <span className="text-muted-foreground">Filled</span>
                                    <div className="font-mono font-semibold">{filledQty != null ? `${filledQty} @ ${fillPrice != null ? formatINR2(Number(fillPrice)) : '—'}` : '—'}</div>
                                  </div>
                                </div>
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-muted-foreground">Tap to view details • {o.orderId ? `Order ${o.orderId}` : 'No order ID yet'}</span>
                                  <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveOrderFromBasket(b._id, i); }} className="text-[10px] text-destructive hover:underline">Remove</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Add order to existing basket */}
                      {!isExpired && (() => {
                        const maxOrders = (b as any).maxOrders ?? 20;
                        const atLimit = maxOrders > 0 && orders.length >= maxOrders;
                        return (
                          <div className="flex items-center gap-2">
                            {!atLimit ? (
                              <div className="flex-1 flex items-center gap-2">
                                <div className="flex-1">
                                  <InstrumentSearch onSelect={(sel) => {
                                    // The real LTP the search returned is kept on
                                    // the leg so the stored leg can be executed by
                                    // a price-less engine later.
                                    const leg = seedLeg(caps, { instrument: { ...sel }, side: 'BUY', product: caps.products[0] ?? 'MIS', orderType: 'MKT', quantity: '1' });
                                    const q = quoteMap[sel.symbol.toUpperCase()];
                                    if (q?.ltp) leg.price = String(q.ltp);
                                    handleAddLegToBasket(b._id, leg);
                                  }} disabled={isExecuting} />
                                </div>
                              </div>
                            ) : (
                              <span className="text-[11px] text-destructive">Maximum order limit reached ({maxOrders}).</span>
                            )}
                          </div>
                        );
                      })()}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-2 flex-wrap">
                        {!isExpired ? (
                          <Button size="sm" className="gap-1.5" onClick={() => handleExecute(b._id)} disabled={isExecuting || orders.length === 0}>
                            {isExecuting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                            {isExecuting ? 'Executing…' : `Execute on ${caps.name}`}
                          </Button>
                        ) : (
                          <Badge variant="destructive">● EXPIRED — execution disabled</Badge>
                        )}
                        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setEditingBasket(b); setEditName(b.name); setEditAllocation(String((b as any).allocatedAmount ?? '')); setEditExpiry((b as any).expiry ?? 'Today'); }}>
                          <History className="h-3 w-3" /> Edit
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => handleDuplicate(b)}>
                          <Copy className="h-3 w-3" /> Duplicate
                        </Button>
                        {deleteConfirmId === b._id ? (
                          <>
                            <Button size="sm" variant="destructive" onClick={() => handleDelete(b._id)}>Confirm Delete</Button>
                            <Button size="sm" variant="outline" onClick={() => setDeleteConfirmId(null)}>Cancel</Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" className="gap-1.5 text-destructive" onClick={() => setDeleteConfirmId(b._id)}>
                            <Trash2 className="h-3 w-3" /> Delete
                          </Button>
                        )}
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </div>
      )}

      {/* ═══════ ADD LEGS SECTION ═══════ */}
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add legs to new basket</h3>
          <span className="text-[10px] tabular-nums text-muted-foreground/70">{legs.length} leg{legs.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="p-4 space-y-3">
          <InstrumentSearch onSelect={(sel) => { addLeg(sel); setAddOrderOpen(false); }} disabled={placing} />

          {legs.length > 0 && (
            <ul className="space-y-2">
              {legs.map((l) => {
                const check = prechecks[l.key];
                const quote = getQuote(l.instrument.symbol);
                const ltp = quote?.ltp;
                return (
                  <li key={l.key} className="rounded-lg border border-border/60 bg-background p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-semibold text-sm">{l.instrument.symbol || 'Select instrument'}</span>
                        {ltp && <span className="ml-2 text-[10px] text-muted-foreground">LTP ₹{ltp.toFixed(2)}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        {check && (
                          <StatusBadge
                            status={check.kind === 'PASS' ? 'success' : check.kind === 'BLOCK' ? 'danger' : 'neutral'}
                            label={check.kind === 'PASS' ? 'PASS' : check.kind === 'BLOCK' ? 'BLOCKED' : 'IDLE'}
                          />
                        )}
                        <button type="button" onClick={() => removeLeg(l.key)} className="rounded-md border border-border px-1.5 py-1 text-muted-foreground hover:border-destructive/40 hover:text-destructive" aria-label="Remove leg">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-6 gap-2">
                      <div>
                        <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Side</Label>
                        <Select value={l.side} onValueChange={(v) => patchLeg(l.key, { side: v })} disabled={placing}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent><SelectItem value="BUY">BUY</SelectItem><SelectItem value="SELL">SELL</SelectItem></SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Product</Label>
                        <Select value={l.product} onValueChange={(v) => patchLeg(l.key, { product: v })} disabled={placing}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{caps.products.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Type</Label>
                        <Select value={l.orderType} onValueChange={(v) => patchLeg(l.key, { orderType: v })} disabled={placing}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>{caps.orderTypes.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Qty</Label>
                        <Input type="number" min="1" value={l.quantity} onChange={(e) => patchLeg(l.key, { quantity: e.target.value })} className="h-8 text-xs" disabled={placing} />
                      </div>
                      {needsPrice(l.orderType) ? (
                        <div>
                          <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Price</Label>
                          <Input type="number" value={l.price} onChange={(e) => patchLeg(l.key, { price: e.target.value })} className="h-8 text-xs" disabled={placing} />
                          {ltp && <button type="button" className="text-[9px] text-primary hover:underline" onClick={() => patchLeg(l.key, { price: ltp.toFixed(2) })}>Use LTP</button>}
                        </div>
                      ) : (
                        <div className="h-8 flex items-center text-xs text-muted-foreground border rounded-lg px-2 bg-muted/30">MKT</div>
                      )}
                      {needsTrigger(l.orderType) ? (
                        <div>
                          <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Trigger</Label>
                          <Input type="number" value={l.triggerPrice} onChange={(e) => patchLeg(l.key, { triggerPrice: e.target.value })} className="h-8 text-xs" disabled={placing} />
                        </div>
                      ) : (
                        <div>
                          <Label className="text-[9px] font-semibold uppercase text-muted-foreground">Validity</Label>
                          <Select value={l.validity} onValueChange={(v) => patchLeg(l.key, { validity: v })} disabled={placing}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>{VALIDITIES.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ═══════ EXECUTE / SUMMARY ═══════ */}
      {legs.length > 0 && (
        <section className="rounded-xl border border-border bg-card">
          <div className="border-b border-border/50 px-4 py-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Basket summary</h3>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div><span className="text-muted-foreground">Total Value</span><div className="font-semibold font-mono">{totalValueLabel}</div></div>
              <div><span className="text-muted-foreground">Est. Charges</span><div className="font-semibold font-mono">{totalChargesLabel}</div></div>
              <div><span className="text-muted-foreground">Est. Margin</span><div className="font-semibold font-mono">{totalMarginLabel}</div></div>
              <div><span className="text-muted-foreground">Available Margin</span><div className="font-semibold font-mono">{fundsKnown ? `₹${availableMargin.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</div></div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="lg" className="flex-1 gap-2" onClick={() => setPreviewOpen(true)} disabled={!canPlace}>
                {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Execute on {caps.name} ({legs.length} legs)
              </Button>
            </div>
            {legsWithoutLtp.length > 0 && terminal === 'dummy' && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <p className="text-[11px] leading-relaxed text-warning/90">
                  No live market data for {legsWithoutLtp.filter(Boolean).join(', ') || 'some legs'}. The Dummy
                  engine prices only from a real LTP, so {legsWithoutLtp.length === 1 ? 'that leg' : 'those legs'}{' '}
                  will be rejected instead of filled at a guessed price. Kotak prices from its own feed.
                </p>
              </div>
            )}
            {!allValid && <p className="text-[10px] text-muted-foreground/70">Complete every leg to unlock execution.</p>}
            {!loggedIn && <p className="text-[10px] text-destructive">Connect {caps.name} to execute.</p>}
          </div>
        </section>
      )}

      {/* ═══════ EXECUTION STATE ═══════ */}
      <BasketExecutionState exec={execState} />

      {/* ═══════ CONFIRM DIALOG ═══════ */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Basket · {legs.length} legs</DialogTitle>
            <DialogDescription>Each leg runs through Risk Engine → Adapter. Partial failures show per-leg results.</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-y-auto space-y-1 rounded-xl border border-border/60 divide-y divide-border/60">
            {legs.map((l) => {
              const check = prechecks[l.key];
              return (
                <div key={l.key} className="flex items-center justify-between gap-3 py-1.5 text-xs">
                  <span className="min-w-0 grow truncate">
                    <span className="font-semibold">{l.instrument.symbol || 'Select'}</span>
                    <span className="ml-2 text-muted-foreground">{l.side} · {l.orderType} · qty {l.quantity}</span>
                  </span>
                  <StatusBadge status={check?.kind === 'PASS' ? 'success' : check?.kind === 'BLOCK' ? 'danger' : 'warning'} label={check?.kind ?? 'PENDING'} />
                </div>
              );
            })}
          </div>
          {!allPass && <p className="text-[11px] text-destructive">Every leg must pass the Risk Engine.</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)} disabled={placing}>Back</Button>
            <Button onClick={async () => {
              setPreviewOpen(false);
              if (legs.length === 0) return;
              try {
                setPlacing(true);
                const res = await createBasket({
                  name: (newName || '').trim() || `Basket ${baskets.length + 1}`,
                  orders: legs.map(legToOrder),
                  cancelOnFill: true,
                  maxOrders: parseInt(newMaxOrders) || legs.length,
                  allocatedAmount: Number(newAllocation) || 0,
                  expiry: newExpiry,
                });
                // apiFetch returns the response body — the basket lives under
                // `data`. Reading `res._id` was undefined, so execution never
                // started after "Create & Execute".
                const basketId = res?.data?._id ?? res?._id ?? res?.id;
                if (basketId) {
                  await handleExecute(basketId);
                }
              } catch (err: any) {
                toast({ title: 'Error', description: err?.message ?? 'Failed to create and execute basket', variant: 'destructive' });
              } finally {
                setPlacing(false);
                setLegs([]);
                setNewName('');
              }
            }} disabled={!allPass || placing}>
              {placing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
              {placing ? 'Executing…' : 'Create & Execute'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══════ CREATE BASKET DIALOG ═══════ */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Basket</DialogTitle>
            <DialogDescription>Create a new basket to group multiple orders.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Basket Name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Momentum Basket" className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Maximum Orders</Label>
                <Input type="number" value={newMaxOrders} onChange={(e) => setNewMaxOrders(e.target.value)} placeholder="10" className="mt-1" />
              </div>
              <div>
                <Label>Broker / Terminal</Label>
                <div className="mt-1 h-9 flex items-center px-2.5 rounded-lg border border-border bg-muted/20 text-xs font-semibold">
                  {caps.name} · {caps.modeLabel}
                </div>
              </div>
            </div>
            <div>
              <Label>Allocated Amount (₹)</Label>
              <Input type="number" value={newAllocation} onChange={(e) => setNewAllocation(e.target.value)} placeholder="100000" className="mt-1" />
            </div>
            <div>
              <Label>Expiry</Label>
              <Select value={newExpiry} onValueChange={setNewExpiry}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Today">Today</SelectItem>
                  <SelectItem value="This Week">This Week</SelectItem>
                  <SelectItem value="This Month">This Month</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateBasket} disabled={!newName.trim() || legs.length === 0 || creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {creating ? 'Creating…' : 'Create Basket'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══════ EDIT BASKET DIALOG ═══════ */}
      <Dialog open={!!editingBasket} onOpenChange={(o) => !o && setEditingBasket(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Basket</DialogTitle>
            <DialogDescription>Update basket details. Orders can be managed inside the basket card.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Basket Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Basket name" className="mt-1" />
            </div>
            <div>
              <Label>Allocated Amount (₹)</Label>
              <Input type="number" value={editAllocation} onChange={(e) => setEditAllocation(e.target.value)} placeholder="100000" className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Expiry</Label>
                <Select value={editExpiry} onValueChange={setEditExpiry}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Today">Today</SelectItem>
                    <SelectItem value="This Week">This Week</SelectItem>
                    <SelectItem value="This Month">This Month</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Broker / Terminal</Label>
                <div className="mt-1 h-9 flex items-center px-2.5 rounded-lg border border-border bg-muted/20 text-xs font-semibold">
                  {caps.name} · {caps.modeLabel}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingBasket(null)}>Cancel</Button>
            <Button onClick={handleEditBasket} disabled={!editName.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══════ ORDER DETAIL DIALOG ═══════ */}
      <Dialog open={!!selectedOrder} onOpenChange={(o) => !o && setSelectedOrder(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Order Detail · {selectedOrder?.symbol}</DialogTitle>
            <DialogDescription>Order #{selectedOrder?.index != null ? Number(selectedOrder.index) + 1 : '—'} in {selectedOrder?.basketName ?? 'basket'}</DialogDescription>
          </DialogHeader>
          {selectedOrder && (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div><span className="text-muted-foreground">Basket ID</span><div className="font-mono font-semibold truncate">{selectedOrder.basketId ?? '—'}</div></div>
                <div><span className="text-muted-foreground">Symbol</span><div className="font-semibold">{selectedOrder.symbol}</div></div>
                <div><span className="text-muted-foreground">Exchange</span><div className="font-mono">{selectedOrder.exchange ?? 'nse_cm'}</div></div>
                <div><span className="text-muted-foreground">Side</span><div className={cn('font-bold', selectedOrder.transactionType === 'BUY' ? 'text-success' : 'text-destructive')}>{selectedOrder.transactionType}</div></div>
                <div><span className="text-muted-foreground">Quantity</span><div className="font-mono">{selectedOrder.quantity}</div></div>
                <div><span className="text-muted-foreground">Filled Quantity</span><div className="font-mono">{selectedOrder.filledQty ?? '—'}</div></div>
                <div><span className="text-muted-foreground">Order Type</span><div className="font-mono">{selectedOrder.orderType}</div></div>
                <div><span className="text-muted-foreground">Product</span><div className="font-mono">{selectedOrder.product}</div></div>
                <div><span className="text-muted-foreground">Requested Price</span><div className="font-mono">{selectedOrder.price !== '0' ? formatINR2(Number(selectedOrder.price)) : 'MKT'}</div></div>
                <div><span className="text-muted-foreground">Average Fill Price</span><div className="font-mono">{selectedOrder.fillPrice != null ? formatINR2(Number(selectedOrder.fillPrice)) : '—'}</div></div>
                <div><span className="text-muted-foreground">LTP</span><div className="font-mono">{selectedOrder.ltp != null ? formatINR2(selectedOrder.ltp) : '—'}</div></div>
                <div><span className="text-muted-foreground">Order Value</span><div className="font-mono">{formatINR(selectedOrder.estimatedValue)}</div></div>
                <div><span className="text-muted-foreground">Margin</span><div className="font-mono">{formatINR(selectedOrder.margin)}</div></div>
                <div><span className="text-muted-foreground">Charges</span><div className="font-mono">{formatINR(selectedOrder.chargesTotal)}</div></div>
                <div><span className="text-muted-foreground">Status</span><div><StatusBadge status={statusTone(selectedOrder.status)} label={selectedOrder.status ?? 'PENDING'} /></div></div>
                <div><span className="text-muted-foreground">Order ID</span><div className="font-mono">{selectedOrder.orderId ?? '—'}</div></div>
                {selectedOrder.error && <div className="col-span-2"><span className="text-muted-foreground">Rejection Reason</span><div className="text-destructive">{String(selectedOrder.error)}</div></div>}
              </div>
              <Separator />
              <div className="flex items-center gap-2">
                <StatusBadge status={statusTone(selectedOrder.status)} label={selectedOrder.status ?? 'UNKNOWN'} />
                <span className="text-muted-foreground">Order {selectedOrder.transactionType} {selectedOrder.quantity} {selectedOrder.symbol} @ {selectedOrder.orderType === 'MKT' ? 'Market' : formatINR2(Number(selectedOrder.price))}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedOrder(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══════ POSITIONS / ACCOUNT / NOTIFICATIONS ═══════ */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2"><Activity className="h-3.5 w-3.5" /> Positions</h3>
          {positions && positions.length > 0 ? (
            <div className="mt-3 space-y-2">
              {positions.slice(0, 6).map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="font-semibold">{p.symbol ?? p.tradingSymbol ?? p.sym ?? '—'}</span>
                  <span className="font-mono">{p.netQty ?? p.netQuantity ?? p.qty ?? '—'}</span>
                  <span className={cn('font-mono', (p.unrealizedPnl ?? p.pnl ?? 0) >= 0 ? 'text-success' : 'text-destructive')}>{p.unrealizedPnl != null ? formatINR(p.unrealizedPnl) : p.pnl != null ? formatINR(p.pnl) : '—'}</span>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground">Updated via Position Engine</p>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">No open positions. Execute a basket to create positions.</p>
          )}
        </section>
        <section className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2"><IndianRupee className="h-3.5 w-3.5" /> Account</h3>
          <div className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Available Margin</span><span className="font-mono font-semibold">{fundsKnown ? formatINR(availableMargin) : '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Used Margin</span><span className="font-mono font-semibold">{fundsKnown ? formatINR(usedMargin) : '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Remaining</span><span className="font-mono font-semibold">{fundsKnown ? formatINR(remainingMargin) : '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total Value (pending)</span><span className="font-mono font-semibold">{totalValueLabel}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Est. Charges</span><span className="font-mono font-semibold">{totalChargesLabel}</span></div>
            <p className="text-[10px] text-muted-foreground pt-1">Via Account Engine · Margin Engine · Charge Engine</p>
          </div>
        </section>
        <section className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2"><ScrollText className="h-3.5 w-3.5" /> Activity</h3>
          {notifications && notifications.length > 0 ? (
            <div className="mt-3 space-y-1.5 max-h-40 overflow-y-auto">
              {notifications.slice(0, 8).map((n: any, i: number) => (
                <div key={i} className="text-[11px] leading-relaxed border border-border/40 rounded-lg p-2 bg-muted/20">
                  <div className="font-medium truncate">{n.title ?? n.message ?? n.text ?? JSON.stringify(n).slice(0, 80)}</div>
                  <div className="text-muted-foreground text-[10px]">{n.createdAt ?? n.timestamp ?? ''}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">No notifications yet. Basket events will appear here via Notification Engine.</p>
          )}
        </section>
      </div>
    </div>
  );
}
