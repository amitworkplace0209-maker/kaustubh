'use client';

/**
 * Order Engine live data hook.
 *
 * Two independent real-time sources, merged without polling the order book:
 *
 * 1. `order.update` / `trade.fill` WS frames patch rows in place. A fill must
 *    appear without a refetch — the doc requires incremental updates, not a full
 *    application rerender (doc §50).
 * 2. The shared tick stream supplies the live LTP per order symbol, which is
 *    what makes "waiting for LTP to match" legible: the user can see the price
 *    their working order is waiting on.
 *
 * A periodic reconcile still runs, but only as a slow safety net for anything
 * the frame stream missed (a reconnect, a broker that does not push order
 * updates). The frames are the primary path, not an optimisation over polling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { subscribeTicks } from '@/lib/shared-sse';
import {
  cancelEngineOrder,
  connectDummyTerminal,
  getOrderEngineOrders,
  getOrderEngineState,
  modifyEngineOrder,
  placeEngineOrder,
  type CanonicalOrder,
  type EngineOrderIntent,
  type MarketDataStatus,
  type OrderEngineState,
} from '@/lib/api';

const RECONCILE_MS = 20000;

export interface OrderEngineLive {
  state: OrderEngineState | null;
  orders: CanonicalOrder[];
  counts: Record<string, number>;
  marketData: MarketDataStatus | null;
  /** Live LTP keyed by uppercase symbol, from the real tick stream. */
  ltp: Record<string, number>;
  loading: boolean;
  error: string;
  live: boolean;
  /** Dummy terminal connection state. */
  dummyConnected: boolean;
  dummyConnecting: boolean;
  refresh: () => Promise<void>;
  place: (intent: EngineOrderIntent) => Promise<{ ok: boolean; message: string }>;
  cancel: (orderId: string) => Promise<{ ok: boolean; message: string }>;
  modify: (
    orderId: string,
    changes: { quantity?: number; price?: number; trigger_price?: number },
  ) => Promise<{ ok: boolean; message: string }>;
  /** Connect / ensure-ready the Dummy (paper) terminal. */
  connectDummy: () => Promise<{ ok: boolean; message: string }>;
}

function countStatuses(orders: CanonicalOrder[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const order of orders) {
    counts[order.status] = (counts[order.status] ?? 0) + 1;
  }
  counts.TOTAL = orders.length;
  counts.WORKING = orders.filter((o) => o.working).length;
  return counts;
}

/** Map a broker-native status from a realtime frame onto the canonical set. */
function canonicalFromFrame(status: unknown): CanonicalOrder['status'] {
  const text = String(status ?? '').trim().toUpperCase().replace(/_/g, ' ');
  if (!text) return 'UNKNOWN';
  if (text === 'COMPLETE' || text === 'COMPLETED' || text === 'FILLED' || text === 'EXECUTED' || text === 'TRADED') {
    return 'COMPLETE';
  }
  if (text === 'REJECTED' || text === 'REJECT' || text === 'FAILED' || text === 'EXPIRED' || text === 'NOT OK') {
    return 'REJECTED';
  }
  if (text === 'CANCELLED' || text === 'CANCELED') return 'CANCELLED';
  if (text === 'PARTIALLY FILLED' || text === 'PARTIAL' || text === 'PARTFULL') return 'PARTIALLY_FILLED';
  if (text === 'TRIGGER PENDING' || text === 'OPEN PENDING' || text === 'TRIGGERPENDING') return 'TRIGGER_PENDING';
  if (text === 'OPEN') return 'OPEN';
  return 'PENDING';
}

export function useOrderEngineLive(): OrderEngineLive {
  const realtime = useFrontendRealtime();
  const [state, setState] = useState<OrderEngineState | null>(null);
  const [orders, setOrders] = useState<CanonicalOrder[]>([]);
  const [marketData, setMarketData] = useState<MarketDataStatus | null>(null);
  const [ltp, setLtp] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [frameEpoch, setFrameEpoch] = useState(0);
  const pendingLtp = useRef<Record<string, number>>({});
  const [dummyConnected, setDummyConnected] = useState(false);
  const [dummyConnecting, setDummyConnecting] = useState(false);
  const refreshing = useRef(false);

  const REFRESH_TIMEOUT_MS = 10000;

  const refresh = useCallback(async () => {
    // Prevent overlapping refresh calls — never stack API calls.
    if (refreshing.current) return;
    refreshing.current = true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

    try {
      const [stateRes, ordersRes] = await Promise.all([
        getOrderEngineState({ signal: controller.signal }),
        getOrderEngineOrders(undefined, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setState(stateRes);
      setOrders(ordersRes.orders ?? []);
      setMarketData(ordersRes.marketData ?? stateRes.marketData ?? null);
      setDummyConnected(Boolean(stateRes.connected && stateRes.isPaper));
      setError('');
    } catch (exc: any) {
      if (exc?.name === 'AbortError') {
        setError('Order engine request timed out — backend may be slow or unreachable.');
      } else {
        setError(exc?.message ?? String(exc));
      }
    } finally {
      clearTimeout(timer);
      refreshing.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Slow safety net. The realtime frames below are the primary update path;
  // this only re-syncs rows a reconnect or a non-pushing broker could leave stale.
  useEffect(() => {
    const id = window.setInterval(() => void refresh(), RECONCILE_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Subscribe to the `orders` state channel so the backend pushes order
  // transitions for the active terminal into this session.
  useEffect(() => {
    void realtime.subscribe([{ channel: 'orders' }]).catch(() => {});
  }, [realtime]);

  // Primary real-time path: patch the affected row instead of refetching.
  useEffect(() => {
    return realtime.onFrame((frame) => {
      if (frame.channel && frame.channel !== 'orders' && frame.channel !== 'positions') return;
      if (frame.type !== 'order.update' && frame.type !== 'trade.fill') return;

      const data = (frame.data ?? {}) as Record<string, any>;
      const orderId = String(data.orderId ?? data.order_id ?? data.n_ord_no ?? '');
      if (!orderId) return;
      const status = canonicalFromFrame(data.status);

      setOrders((prev) => {
        const index = prev.findIndex((o) => o.orderId === orderId);
        const filled = Number(data.filledQuantity ?? 0) || 0;
        const avg = Number(data.averageTradedPrice ?? 0) || 0;
        const reason = String(data.reason ?? '');

        if (index === -1) {
          // A row we have not seen yet (placed from another surface, or after a
          // reconnect). Defer to the reconcile rather than guessing its fields.
          setFrameEpoch((n) => n + 1);
          return prev;
        }
        const current = prev[index];
        // Never walk a row backwards out of a terminal state — the broker is
        // authoritative and a late/duplicate frame must not resurrect it.
        const currentTerminal =
          current.status === 'COMPLETE' || current.status === 'REJECTED' || current.status === 'CANCELLED';
        const nextStatus = currentTerminal && status !== current.status ? current.status : status;

        const updated: CanonicalOrder = {
          ...current,
          status: nextStatus,
          rawStatus: String(data.status ?? current.rawStatus),
          working: nextStatus === 'PENDING' || nextStatus === 'OPEN' || nextStatus === 'TRIGGER_PENDING' || nextStatus === 'PARTIALLY_FILLED',
          executed: nextStatus === 'COMPLETE',
          filledQuantity: filled || current.filledQuantity,
          pendingQuantity: Math.max((current.quantity || 0) - (filled || current.filledQuantity), 0),
          averagePrice: avg || current.averagePrice,
          reason: reason || (nextStatus === 'REJECTED' ? current.reason : ''),
          waitingReason: nextStatus === current.status ? current.waitingReason : '',
        };
        const next = [...prev];
        next[index] = updated;
        return next;
      });
    });
  }, [realtime]);

  // Re-sync when an unknown order shows up over the frame stream.
  useEffect(() => {
    if (frameEpoch > 0) void refresh();
  }, [frameEpoch, refresh]);

  // Live LTP for every instrument the order book touches. Batched so a fast feed
  // re-renders once per window instead of once per trade.
  useEffect(() => {
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      const next = pendingLtp.current;
      if (Object.keys(next).length === 0) return;
      setLtp((prev) => ({ ...prev, ...next }));
      pendingLtp.current = {};
    };
    const off = subscribeTicks((tick: any) => {
      const symbol = String(tick?.symbol ?? tick?.tradingSymbol ?? '').toUpperCase();
      const price = Number(tick?.ltp ?? tick?.lastPrice ?? 0);
      if (!symbol || !(price > 0)) return;
      pendingLtp.current[symbol] = price;
      if (timer == null) timer = window.setTimeout(flush, 400);
    });
    return () => {
      off();
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  const counts = useMemo(() => countStatuses(orders), [orders]);

  const place = useCallback<OrderEngineLive['place']>(
    async (intent) => {
      try {
        const res = await placeEngineOrder(intent);
        const status = String(res.status ?? '').toUpperCase();
        if (!res.ok) {
          const message = res.error?.message || res.reasons?.join('; ') || 'order rejected';
          toast.error('Order rejected', { description: message });
          return { ok: false, message };
        }
        // Accepted is not executed. Say which one actually happened.
        if (res.working) {
          toast.success(`Order ${status.toLowerCase().replace(/_/g, ' ')}`, {
            description: 'Accepted by the broker — it will execute when the live price matches.',
          });
        } else {
          toast.success('Order executed', {
            description: `${intent.transaction_type} ${intent.quantity} ${String(intent.symbol).toUpperCase()}`,
          });
        }
        await refresh();
        return { ok: true, message: status || 'ACCEPTED' };
      } catch (exc: any) {
        const message = exc?.message ?? String(exc);
        toast.error('Order failed', { description: message });
        return { ok: false, message };
      }
    },
    [refresh],
  );

  const cancel = useCallback<OrderEngineLive['cancel']>(
    async (orderId) => {
      try {
        const res = await cancelEngineOrder(orderId);
        if (!res.ok) {
          const message = res.error?.message || 'cancel rejected';
          toast.error('Cancel failed', { description: message });
          return { ok: false, message };
        }
        toast.success('Order cancelled', { description: `Order ${orderId}` });
        await refresh();
        return { ok: true, message: 'CANCELLED' };
      } catch (exc: any) {
        const message = exc?.message ?? String(exc);
        toast.error('Cancel failed', { description: message });
        return { ok: false, message };
      }
    },
    [refresh],
  );

  const modify = useCallback<OrderEngineLive['modify']>(
    async (orderId, changes) => {
      try {
        const res = await modifyEngineOrder(orderId, {
          quantity: changes.quantity != null ? String(changes.quantity) : undefined,
          price: changes.price != null ? String(changes.price) : undefined,
          trigger_price: changes.trigger_price != null ? String(changes.trigger_price) : undefined,
        });
        if (!res.ok) {
          const message = res.error?.message || res.reasons?.join('; ') || 'modify rejected';
          toast.error('Modify failed', { description: message });
          return { ok: false, message };
        }
        toast.success('Order modified', { description: `Order ${orderId}` });
        await refresh();
        return { ok: true, message: 'MODIFIED' };
      } catch (exc: any) {
        const message = exc?.message ?? String(exc);
        toast.error('Modify failed', { description: message });
        return { ok: false, message };
      }
    },
    [refresh],
  );

  const connectDummy = useCallback<OrderEngineLive['connectDummy']>(
    async () => {
      setDummyConnecting(true);
      try {
        const res = await connectDummyTerminal();
        setDummyConnected(Boolean(res?.connected));
        if (res?.ok) {
          toast.success('Dummy terminal connected', {
            description: res?.message ?? 'Paper engine is ready',
          });
          await refresh();
          return { ok: true, message: res?.message ?? 'connected' };
        }
        const message = res?.error?.message || res?.message || 'connect failed';
        toast.error('Dummy connect failed', { description: message });
        return { ok: false, message };
      } catch (exc: any) {
        const message = exc?.message ?? String(exc);
        toast.error('Dummy connect failed', { description: message });
        return { ok: false, message };
      } finally {
        setDummyConnecting(false);
      }
    },
    [refresh],
  );

  return {
    state,
    orders,
    counts,
    marketData,
    ltp,
    loading,
    error,
    dummyConnected,
    dummyConnecting,
    live: realtime.connected,
    refresh,
    place,
    cancel,
    modify,
    connectDummy,
  };
}