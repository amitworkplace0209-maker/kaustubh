'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  realtimeClient,
  RealtimeAck,
  RealtimeChannelSpec,
  RealtimeEnvelope,
  RealtimeLiveState,
  RealtimeTickView,
} from '@/lib/realtime-ws';
import { useAuth } from '@/components/auth-provider';

/**
 * FrontendRealtimeProvider — mounts the ONE persistent WebSocket connection
 * (WS#3 down + WS#4 up, Backend ⇄ Frontend) and shares it through `useFrontendRealtime()`.
 *
 * Design per WebSocket_ConnectionManager_Flow.md:
 *  * WS#3 Backend → Frontend: realtime market ticks, orders, positions, P&L,
 *    risk/margin, notifications, connection state (via Connection Manager)
 *  * WS#4 Frontend → Backend: commands (place/cancel/modify/square-off etc.)
 *    routed via Command Router → OrderEngine/Risk/Audit/Broker Terminal → Kotak REST
 *  * The provider owns `realtimeClient` (module singleton). Consumers never
 *    open their own socket.
 *  * Market ticks stay latest-value in the client tick store and only cause a
 *    React re-render at ~4Hz (thrash guard) so large watchlists stay cheap.
 *  * The system-state bridge (SSE `RealtimeProvider`) is intentionally left
 *    untouched — it owns the system snapshot/delta state. This provider owns
 *    the realtime market + event frames on WS#3/WS#4 (the single /ws/realtime
 *    bidirectional socket).
 *  * Auth-gated: the socket is only connected once the Next-layer app session
 *    exists (`useAuth`). On logout/login the client is closed / reconnected so
 *    no unauthenticated token requests ever fire.
 *  * If the gateway is unreachable (legacy backend), `connectionState` shows
 *    RECONNECTING/ERROR and consumers fall back to their existing SSE
 *    polling — nothing throws.
 */
export type FrontendRealtimeValue = {
  connectionId: string;
  username: string;
  connectionState: RealtimeLiveState;
  /** Failure reason when stuck in AUTH_FAILED / ERROR ('' otherwise). */
  failureReason: string;
  connected: boolean;
  /** Latest values keyed by `SEGMENT|TOKEN` (freshest frame wins). */
  ticks: Map<string, RealtimeTickView>;
  /** Bumped ~4Hz while market frames flow — re-read `ticks` on it. */
  tickEpoch: number;
  subscribe: (specs: RealtimeChannelSpec[], requestId?: string) => Promise<RealtimeAck>;
  unsubscribe: (specs: RealtimeChannelSpec[], requestId?: string) => Promise<RealtimeAck>;
  requestSnapshot: (requestId?: string) => Promise<Record<string, any>>;
  /** WS#4: place/cancel/modify/square-off via Command Router (Order Engine). */
  placeOrder: (order: Record<string, any>, requestId?: string) => Promise<RealtimeAck>;
  cancelOrder: (orderId: string, requestId?: string) => Promise<RealtimeAck>;
  modifyOrder: (orderId: string, order: Record<string, any>, requestId?: string) => Promise<RealtimeAck>;
  squareOff: (position: Record<string, any>, requestId?: string) => Promise<RealtimeAck>;
  /** Register a listener for every inbound envelope frame (WS#3 down). */
  onFrame: (cb: (frame: RealtimeEnvelope) => void) => () => void;
};

const EMPTY_VALUE: FrontendRealtimeValue = {
  connectionId: '',
  username: '',
  connectionState: 'DISCONNECTED',
  failureReason: '',
  connected: false,
  ticks: new Map(),
  tickEpoch: 0,
  subscribe: () => Promise.resolve({ ok: false, requestId: '', errors: [{ error: 'not mounted' }] }),
  unsubscribe: () => Promise.resolve({ ok: false, requestId: '', errors: [{ error: 'not mounted' }] }),
  requestSnapshot: () => Promise.reject(new Error('not mounted')),
  placeOrder: () => Promise.resolve({ ok: false, requestId: '', errors: [{ error: 'not mounted' }] }),
  cancelOrder: () => Promise.resolve({ ok: false, requestId: '', errors: [{ error: 'not mounted' }] }),
  modifyOrder: () => Promise.resolve({ ok: false, requestId: '', errors: [{ error: 'not mounted' }] }),
  squareOff: () => Promise.resolve({ ok: false, requestId: '', errors: [{ error: 'not mounted' }] }),
  onFrame: () => () => {},
};

const FrontendRealtimeContext = createContext<FrontendRealtimeValue>(EMPTY_VALUE);

export function useFrontendRealtime() {
  return useContext(FrontendRealtimeContext);
}

const FLUSH_MS = 250;

export function FrontendRealtimeProvider({ children }: { children: React.ReactNode }) {
  const { authenticated } = useAuth();
  const [connectionId, setConnectionId] = useState('');
  const [username, setUsername] = useState('');
  const [connectionState, setConnectionState] = useState<RealtimeLiveState>('DISCONNECTED');
  const [failureReason, setFailureReason] = useState('');
  const [ticks, setTicks] = useState<Map<string, RealtimeTickView>>(new Map());
  const [tickEpoch, setTickEpoch] = useState(0);

  const dirtyRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const knownSubsRef = useRef<Map<string, Set<string>>>(new Map());
  /** State-channel subscriptions (specs WITHOUT instruments). The realtime
   *  client clears `stateSubscriptions` on socket close and only re-adds them
   *  when a new subscribe arrives — track them here so a reconnect restores
   *  orders/positions/engines broadcasts without the page re-mounting. */
  const stateSubsRef = useRef<Set<string>>(new Set());

  const flushTicks = useCallback(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setTicks(realtimeClient.getTicks());
    setTickEpoch((e) => e + 1);
  }, []);

  useEffect(() => {
    let subscribedAfterOpen = false;

    const offState = realtimeClient.onStateChange((s) => {
      setConnectionState(s);
      setFailureReason(realtimeClient.getFailureReason());
      if (s === 'CONNECTED') {
        setConnectionId(realtimeClient.getConnectionId());
        setUsername(realtimeClient.getUsername());
        if (!subscribedAfterOpen) {
          const specs: RealtimeChannelSpec[] = [];
          for (const chan of stateSubsRef.current) {
            specs.push({ channel: chan });
          }
          for (const [channel, keys] of knownSubsRef.current) {
            if (keys.size === 0) continue;
            specs.push({
              channel,
              instruments: Array.from(keys).map((k) => {
                const [exchange_segment, instrument_token] = k.split('|');
                return { exchange_segment, instrument_token };
              }),
            });
          }
          subscribedAfterOpen = true;
          if (specs.length) void realtimeClient.subscribe(specs).catch(() => {});
          void realtimeClient.requestSnapshot().catch(() => {});
        }
      }
      if (s === 'RECONNECTING' || s === 'DISCONNECTED' || s === 'AUTH_FAILED' || s === 'ERROR') {
        subscribedAfterOpen = false;
      }
    });

    const offFrame = realtimeClient.onFrame((frame) => {
      if (frame.type?.startsWith('market.')) dirtyRef.current = true;
    });

    if (!flushTimerRef.current) {
      flushTimerRef.current = setInterval(flushTicks, FLUSH_MS);
    }

    return () => {
      offState();
      offFrame();
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      realtimeClient.close();
    };
  }, [flushTicks]);

  // Auth gate: only an authenticated app session may open the single global
  // socket. Login/logout transitions close and restart it cleanly.
  useEffect(() => {
    if (authenticated) {
      void realtimeClient.connect();
    } else {
      realtimeClient.close();
    }
  }, [authenticated]);

  const subscribe = useCallback(
    async (specs: RealtimeChannelSpec[], requestId?: string) => {
      const ack = await realtimeClient.subscribe(specs, requestId);
      if (ack.ok) {
        for (const spec of specs) {
          const insts = spec.instruments ?? [];
          if (insts.length === 0) {
            stateSubsRef.current.add(spec.channel);
            continue;
          }
          const cur = knownSubsRef.current.get(spec.channel) ?? new Set<string>();
          for (const inst of insts) {
            cur.add(`${inst.exchange_segment ?? ''}|${inst.instrument_token ?? ''}`);
          }
          knownSubsRef.current.set(spec.channel, cur);
        }
      }
      dirtyRef.current = true;
      flushTicks();
      return ack;
    },
    [flushTicks],
  );

  const unsubscribe = useCallback(
    async (specs: RealtimeChannelSpec[], requestId?: string) => {
      const ack = await realtimeClient.unsubscribe(specs, requestId);
      if (ack.ok) {
        for (const spec of specs) {
          const insts = spec.instruments ?? [];
          if (insts.length === 0) {
            stateSubsRef.current.delete(spec.channel);
            continue;
          }
          const cur = knownSubsRef.current.get(spec.channel);
          if (!cur) continue;
          for (const inst of insts) {
            cur.delete(`${inst.exchange_segment ?? ''}|${inst.instrument_token ?? ''}`);
          }
          if (cur.size === 0) knownSubsRef.current.delete(spec.channel);
        }
      }
      return ack;
    },
    [],
  );

  const requestSnapshot = useCallback(
    (requestId?: string) => realtimeClient.requestSnapshot(requestId),
    [],
  );

  const placeOrder = useCallback((order: Record<string, any>, requestId?: string) => realtimeClient.placeOrder(order, requestId), []);
  const cancelOrder = useCallback((orderId: string, requestId?: string) => realtimeClient.cancelOrder(orderId, requestId), []);
  const modifyOrder = useCallback((orderId: string, order: Record<string, any>, requestId?: string) => realtimeClient.modifyOrder(orderId, order, requestId), []);
  const squareOff = useCallback((position: Record<string, any>, requestId?: string) => realtimeClient.squareOff(position, requestId), []);

  const onFrame = useCallback(
    (cb: (frame: RealtimeEnvelope) => void) => realtimeClient.onFrame(cb),
    [],
  );

  const value: FrontendRealtimeValue = {
    connectionId,
    username,
    connectionState,
    failureReason,
    connected: connectionState === 'CONNECTED',
    ticks,
    tickEpoch,
    subscribe,
    unsubscribe,
    requestSnapshot,
    placeOrder,
    cancelOrder,
    modifyOrder,
    squareOff,
    onFrame,
  };

  return (
    <FrontendRealtimeContext.Provider value={value}>
      {children}
    </FrontendRealtimeContext.Provider>
  );
}