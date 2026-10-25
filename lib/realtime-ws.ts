/**
 * Realtime WebSocket client — the FRONTEND half of WS#3 (Backend → Frontend)
 * + WS#4 (Frontend → Backend) per WebSocket_ConnectionManager_Flow.md.
 *
 * ONE persistent, authenticated socket per client that carries every realtime
 * event as an envelope frame (WS#3 down: market.tick, order.updated,
 * position.updated, system.status, connection.status, ...) plus control /
 * command actions (WS#4 up: subscribe / unsubscribe / snapshot / ping /
 * place_order / cancel_order / modify_order / square_off).
 *
 * Convention:
 *   WS#3 down (Backend → Frontend)  envelope { type, event_id, timestamp, sequence, channel, symbol, schema_version, data }
 *   WS#4 up   (Frontend → Backend)  { action, request_id, correlation_id, channels | order | order_id | position }
 */
// Relative + explicit extension: this module is imported directly by the
// Node test runner (`node --test`), and Node's ESM resolver cannot follow a
// path alias (`@/lib/...`) or an extensionless specifier.
import { realtimeSocketUrl } from './api-base.ts';

export type RealtimeLiveState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'AUTHENTICATING'
  | 'AUTH_FAILED'
  | 'ERROR';

export type RealtimeInstrument = {
  exchange_segment: string;
  instrument_token: string;
  symbol?: string;
};

export type RealtimeChannelSpec = {
  channel: string;
  instruments?: RealtimeInstrument[];
  /**
   * Ask the backend to REBUILD the channel's authoritative document instead
   * of answering from the snapshot cache. Used by the explicit "Refresh"
   * action (after a mutation) so the user sees the new state immediately.
   */
  force?: boolean;
};

export type RealtimeEnvelope = {
  type: string;
  event_id?: string;
  timestamp?: string | number;
  sequence?: number;
  channel?: string;
  symbol?: string;
  instrument_token?: string;
  exchange_segment?: string;
  schema_version?: string;
  request_id?: string;
  correlation_id?: string;
  data?: Record<string, any>;
};

/** Latest-value view of one instrument — the UI keeps the freshest frame. */
export type RealtimeTickView = {
  key: string;
  symbol: string;
  instrument_token: string;
  exchange_segment: string;
  channel: string;
  ltp?: number | null;
  ltq?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  volume?: number | null;
  netChange?: number | null;
  netChangePct?: number | null;
  avgPrice?: number | null;
  buy?: number | null;
  sell?: number | null;
  yearlyHigh?: number | null;
  yearlyLow?: number | null;
  lastTradeTime?: string;
  brokerTimestamp?: string;
  receivedAt?: string;
  raw: RealtimeEnvelope;
};

export type RealtimeAck = {
  ok: boolean;
  requestId: string;
  results?: any[];
  errors?: any[];
};

const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 15000;
const BACKOFF_JITTER_MS = 250;
const MAX_CONSECUTIVE_SOCKET_FAILURES = 8;
const ACK_TIMEOUT_MS = 8000;
/** Max time subscribe() waits for CONNECTED before failing fast (never hang UI). */
const WAIT_OPEN_TIMEOUT_MS = 10000;
/** After entering ERROR (8 consecutive failures), ignore new connect() calls
 *  for this long — prevents subscribe-loops from spamming 100+ console.warns
 *  and lets the browser stay responsive. A later connect() past cooldown retries. */
const ERROR_COOLDOWN_MS = 60000;
/** Throttle repeated identical warn logs while stuck (502 / ERROR spam). */
const WARN_THROTTLE_MS = 10000;

/** Structured transition logging — off by default; enable with
 * `NEXT_PUBLIC_REALTIME_DEBUG=1`. Genuine failures log regardless. */
function dbg(...args: unknown[]) {
  if (process.env.NEXT_PUBLIC_REALTIME_DEBUG === '1') {
    console.info('[REALTIME]', ...args);
  }
}

export function realtimeWsUrl(): string {
  // In the browser the socket points at the page's own origin: an absolute
  // `127.0.0.1` socket address is the PHONE on a mobile device, and a plain
  // `ws://` socket is blocked as mixed content on an HTTPS deployment.
  return realtimeSocketUrl();
}
function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

type PendingEntry = {
  onResolve: (v: any) => void;
  onReject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private heartbeatMs = 12000;
  private reconnectAttempt = 0;
  private stopCalled = false;
  private state: RealtimeLiveState = 'DISCONNECTED';
  private connectionId = '';
  private username = '';
  private authFailure = '';
  private connectPromise: Promise<boolean> | null = null;

  private pending = new Map<string, PendingEntry>();
  private frameListeners = new Set<(frame: RealtimeEnvelope) => void>();
  private stateListeners = new Set<(state: RealtimeLiveState) => void>();
  private ticks = new Map<string, RealtimeTickView>();
  private subscriptions = new Map<string, Set<string>>();
  private stateSubscriptions = new Set<string>();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private errorEnteredAt = 0;
  private lastWarnAt = 0;
  private misconfiguredCount = 0;

  // ------------------------------------------------------------------ //
  // State
  // ------------------------------------------------------------------ //
  getState(): RealtimeLiveState {
    return this.state;
  }

  /** Human reason for the AUTH_FAILED / ERROR state ('' when not stuck). */
  getFailureReason(): string {
    return this.authFailure;
  }

  getConnectionId(): string {
    return this.connectionId;
  }

  getUsername(): string {
    return this.username;
  }

  getTicks(): Map<string, RealtimeTickView> {
    return new Map(this.ticks);
  }

  getTick(key: string): RealtimeTickView | undefined {
    return this.ticks.get(key);
  }

  onStateChange(cb: (state: RealtimeLiveState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onFrame(cb: (frame: RealtimeEnvelope) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  private setState(next: RealtimeLiveState) {
    if (this.state === next) return;
    dbg('state', this.state, '->', next);
    this.state = next;
    for (const cb of this.stateListeners) {
      try {
        cb(next);
      } catch {
        // listener errors must never break the socket
      }
    }
  }

  // ------------------------------------------------------------------ //
  // Connection
  // ------------------------------------------------------------------ //
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Open the authenticated singleton socket. Auth-gated: the caller is
   * expected to only connect once an app session exists. A 401 from the token
   * proxy lands in AUTH_FAILED (permanent — no reconnect spam) until the app
   * session changes and `connect()` is called again.
   */
  async connect(): Promise<boolean> {
    if (this.stopCalled) this.stopCalled = false;
    const active =
      this.state === 'CONNECTING' ||
      this.state === 'AUTHENTICATING' ||
      this.state === 'CONNECTED' ||
      this.state === 'RECONNECTING';
    if (active) return true;
    // Circuit breaker: while parked in ERROR (backend down / no creds), fail
    // fast instead of re-running the token fetch + warn on every subscribe()
    // call. Past the cooldown a new attempt is allowed (self-heals).
    if (this.state === 'ERROR') {
      if (Date.now() - this.errorEnteredAt < ERROR_COOLDOWN_MS) return false;
      this.reconnectAttempt = 0;
      this.misconfiguredCount = 0;
    }
    if (this.connectPromise) return this.connectPromise;

    const task = this.connectInternal();
    this.connectPromise = task;
    try {
      return await task;
    } finally {
      this.connectPromise = null;
    }
  }

  private async connectInternal(): Promise<boolean> {
    if (this.stopCalled) return false;
    if (this.isOpen()) return true;

    if (this.reconnectAttempt >= MAX_CONSECUTIVE_SOCKET_FAILURES) {
      this.authFailure = `Socket could not be established after ${MAX_CONSECUTIVE_SOCKET_FAILURES} consecutive attempts. Paused for ${Math.round(ERROR_COOLDOWN_MS / 1000)}s before retrying.`;
      const firstEntry = this.state !== 'ERROR';
      this.setState('ERROR');
      if (firstEntry) this.errorEnteredAt = Date.now();
      // Throttled: log once per transition + at most every WARN_THROTTLE_MS so
      // a stuck backend doesn't flood the console with 100+ identical warns
      // (the freeze/spam seen in production logs).
      const now = Date.now();
      if (firstEntry || now - this.lastWarnAt > WARN_THROTTLE_MS) {
        this.lastWarnAt = now;
        console.warn('[REALTIME]', this.authFailure);
      } else {
        dbg('suppressed repeated ERROR warn (throttled)');
      }
      return false;
    }

    this.setState('AUTHENTICATING');
    const token = await this.fetchGatewayToken();
    if (this.stopCalled) return false;

    if (token.state === 'unauthorized') {
      this.authFailure = 'Not authenticated locally — log in first.';
      this.setState('AUTH_FAILED');
      console.warn('[REALTIME] auth failed (token proxy 401):', this.authFailure);
      return false;
    }
    if (token.state === 'misconfigured') {
      // 502 from the proxy is almost always TRANSIENT (backend restarting /
      // recovering), so retry with backoff instead of parking permanently in
      // AUTH_FAILED. The watchdog heals the backend, after which this fetch
      // succeeds and the socket reconnects on its own.
      // Throttled logging: first failure + every 5th at warn, rest at debug —
      // otherwise an extended backend outage spams the console every ~1-2s.
      this.misconfiguredCount += 1;
      this.authFailure = token.reason;
      this.scheduleRetry(this.authFailure);
      if (this.misconfiguredCount === 1 || this.misconfiguredCount % 5 === 0) {
        console.warn(`[REALTIME] auth blocked (token proxy 502, retrying #${this.misconfiguredCount}):`, this.authFailure);
      } else {
        dbg(`auth blocked (token proxy 502, retrying #${this.misconfiguredCount}, throttled):`, this.authFailure);
      }
      return false;
    }
    if (token.state === 'network') {
      this.authFailure = `Gateway token endpoint unreachable (${token.reason ?? 'network error'}).`;
      this.scheduleRetry(this.authFailure);
      return false;
    }
    if (!token.value) {
      this.authFailure = 'Gateway token endpoint returned no token.';
      this.scheduleRetry(this.authFailure);
      return false;
    }

    const url = `${realtimeWsUrl()}?token=${encodeURIComponent(token.value)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.authFailure = `WebSocket constructor failed: ${String(err)}`;
      this.setState('ERROR');
      console.warn('[REALTIME]', this.authFailure);
      return false;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.misconfiguredCount = 0;
      this.errorEnteredAt = 0;
      this.setState('CONNECTED');
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = (ev) => this.onSocketClose(ev?.code ?? 0, ws);
    ws.onerror = () => {
      // onclose follows immediately
    };
    return true;
  }

  private async fetchGatewayToken(): Promise<
    | { state: 'unauthorized' }
    | { state: 'misconfigured'; reason: string }
    | { state: 'network'; reason: string }
    | { state: 'token'; value: string }
  > {
    let res: Response;
    try {
      res = await fetch('/api/realtime/token', { cache: 'no-store' });
    } catch (err) {
      return { state: 'network', reason: String(err) };
    }
    if (res.status === 401) return { state: 'unauthorized' };
    if (res.status === 502) {
      return { state: 'misconfigured', reason: 'Backend realtime auth is enabled but the app layer has no operator credentials.' };
    }
    if (!res.ok) return { state: 'network', reason: `HTTP ${res.status}` };
    try {
      const body = await res.json();
      return { state: 'token', value: String(body?.token ?? '') };
    } catch {
      return { state: 'network', reason: 'invalid token response' };
    }
  }

  private onSocketClose(code: number, socket: WebSocket) {
    this.stopHeartbeat();
    this.pending.clear();
    if (this.ws === socket) this.ws = null;
    // The backend's route/topic registry lives on OUR connection. When the
    // socket dies the new connection starts blank, so drop the known
    // subscription set here — otherwise the next subscribe() computes an empty
    // delta and never re-subscribes the resumable market/state streams.
    this.subscriptions.clear();
    this.stateSubscriptions.clear();
    if (this.stopCalled) {
      // intentional close
    } else if (code === 4401 || code === 4001) {
      this.authFailure = `Gateway closed the socket (code ${code}) — token expired or revoked. Log in again.`;
      this.setState('AUTH_FAILED');
      console.warn('[REALTIME] auth closed by server:', this.authFailure);
      return;
    } else {
      this.authFailure = `Socket closed (code ${code}).`;
      this.scheduleRetry('');
      return;
    }
    this.setState('DISCONNECTED');
  }

  private scheduleRetry(reason: string) {
    const delay =
      Math.min(BASE_RECONNECT_MS * 2 ** Math.min(this.reconnectAttempt, 6), MAX_RECONNECT_MS) +
      Math.floor(Math.random() * BACKOFF_JITTER_MS);
    this.reconnectAttempt += 1;
    dbg('scheduling retry in', delay, 'ms (attempt', this.reconnectAttempt, ')');
    if (reason) this.authFailure = reason;
    this.setState('RECONNECTING');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopCalled) void this.connectInternal();
    }, delay);
  }

  close() {
    this.stopCalled = true;
    // Intentional close (logout/unmount) resets the failure streak so the next
    // login starts fresh instead of instantly tripping the ERROR breaker.
    this.reconnectAttempt = 0;
    this.misconfiguredCount = 0;
    this.errorEnteredAt = 0;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client close');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setState('DISCONNECTED');
  }

  destroy() {
    this.close();
    this.frameListeners.clear();
    this.stateListeners.clear();
    this.ticks.clear();
    this.subscriptions.clear();
    this.stateSubscriptions.clear();
  }

  // ------------------------------------------------------------------ //
  // Control actions
  // ------------------------------------------------------------------ //
  private sendRaw(message: Record<string, any>): boolean {
    if (!this.isOpen() || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private newRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private track(requestId: string, timeoutMs: number): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`realtime: timeout waiting for ${requestId}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        onResolve: (v) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(v);
        },
        onReject: (err) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(err);
        },
        timer,
      });
    });
  }

  /** Subscribe market/state channels (idempotent client-side merge).
   *
   *  A spec WITHOUT instruments subscribes to the channel's STATE stream
   *  (e.g. ``market_watch`` ranking/pins/status frames) — it is sent verbatim
   *  and tracked separately from market-token subscriptions.
   *
   *  ``options.force`` re-sends a channel that is already subscribed, which
   *  asks the backend to push the channel's authoritative document again. */
  async subscribe(
    specs: RealtimeChannelSpec[],
    requestId?: string,
    options: { force?: boolean } = {},
  ): Promise<RealtimeAck> {
    dbg('subscribe() called', JSON.stringify(specs), 'open=', this.isOpen());
    if (!this.isOpen()) {
      const ok = await this.connect();
      if (!ok) return { ok: false, requestId: requestId ?? '', errors: [{ error: 'socket unavailable (realtime down, using polling fallback)' }] };
      // Fail fast: never hang the caller forever when the socket can't open
      // (token 502 / ERROR cooldown). Previously waitOpen() had no timeout so
      // pages appeared "stuck" and needed a restart.
      try {
        await this.waitOpen(WAIT_OPEN_TIMEOUT_MS);
      } catch {
        return { ok: false, requestId: requestId ?? '', errors: [{ error: 'socket connect timed out (realtime down, using polling fallback)' }] };
      }
      if (!this.isOpen()) {
        return { ok: false, requestId: requestId ?? '', errors: [{ error: 'socket closed' }] };
      }
    }

    const force = options.force === true;
    const stateWanted = new Set<string>();
    const merged = new Map<string, Set<string>>();
    for (const spec of specs) {
      const chan = spec.channel;
      if (!chan) continue;
      const insts = spec.instruments ?? [];
      if (insts.length === 0) {
        stateWanted.add(chan);
        continue;
      }
      const existing = this.subscriptions.get(chan) ?? new Set<string>();
      const next = new Set(existing);
      for (const inst of insts) {
        const key = `${inst.exchange_segment ?? ''}|${inst.instrument_token ?? ''}`;
        if (key !== '|') next.add(key);
      }
      merged.set(chan, next);
    }

    // Only send the delta the backend does not already know about.
    const delta: RealtimeChannelSpec[] = [];
    for (const chan of stateWanted) {
      if (force || !this.stateSubscriptions.has(chan)) {
        delta.push(force ? { channel: chan, force: true } : { channel: chan });
      }
    }
    for (const [chan, keys] of merged) {
      const known = this.subscriptions.get(chan);
      const fresh = force
        ? Array.from(keys)
        : Array.from(keys).filter((k) => !known || !known.has(k));
      if (fresh.length) {
        delta.push({
          channel: chan,
          instruments: fresh.map((k) => {
            const [exchange_segment, instrument_token] = k.split('|');
            return { exchange_segment, instrument_token };
          }),
        });
      }
    }
    if (!delta.length) {
      dbg('subscribe() no delta — already subscribed', JSON.stringify(specs));
      return { ok: true, requestId: requestId ?? '' };
    }

    dbg('subscribe() sending delta', JSON.stringify(delta));

    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'subscribe', channels: delta, request_id: rid })) {
      return { ok: false, requestId: rid, errors: [{ error: 'socket not open' }] };
    }
    const ack = (await promise) as RealtimeAck;
    if (ack.ok) {
      for (const chan of stateWanted) this.stateSubscriptions.add(chan);
      for (const [chan, keys] of merged) {
        const cur = this.subscriptions.get(chan) ?? new Set<string>();
        for (const k of keys) cur.add(k);
        this.subscriptions.set(chan, cur);
      }
    }
    return ack;
  }

  async unsubscribe(specs: RealtimeChannelSpec[], requestId?: string): Promise<RealtimeAck> {
    if (!this.isOpen()) return { ok: false, requestId: requestId ?? '', errors: [{ error: 'socket closed' }] };
    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'unsubscribe', channels: specs, request_id: rid })) {
      return { ok: false, requestId: rid, errors: [{ error: 'socket not open' }] };
    }
    const ack = (await promise) as RealtimeAck;
    if (ack.ok) {
      for (const spec of specs) {
        const insts = spec.instruments ?? [];
        if (insts.length === 0) {
          this.stateSubscriptions.delete(spec.channel);
          continue;
        }
        const cur = this.subscriptions.get(spec.channel);
        if (!cur) continue;
        for (const inst of insts) {
          cur.delete(`${inst.exchange_segment ?? ''}|${inst.instrument_token ?? ''}`);
        }
      }
    }
    return ack;
  }

  /** Ask for a latest-market-value snapshot; resolves with the snapshot data. */
  async requestSnapshot(requestId?: string): Promise<Record<string, any>> {
    if (!this.isOpen()) throw new Error('realtime: socket not open');
    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'snapshot', request_id: rid })) {
      throw new Error('realtime: socket not open');
    }
    return (await promise) as Record<string, any>;
  }

  // ------------------------------------------------------------------ //
  // WS#4 — Frontend → Backend commands (routed to OrderEngine etc.)
  // ------------------------------------------------------------------ //
  /** Place an order via WS#4 (Order Engine → Risk → Audit → Broker REST). WS#2 reports result. */
  async placeOrder(order: Record<string, any>, requestId?: string): Promise<RealtimeAck & { data?: any }> {
    if (!this.isOpen()) throw new Error('realtime: socket not open');
    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'place_order', request_id: rid, correlation_id: rid, order })) throw new Error('realtime: socket not open');
    return (await promise) as RealtimeAck & { data?: any };
  }

  async cancelOrder(orderId: string, requestId?: string): Promise<RealtimeAck & { data?: any }> {
    if (!this.isOpen()) throw new Error('realtime: socket not open');
    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'cancel_order', request_id: rid, correlation_id: rid, order_id: orderId })) throw new Error('realtime: socket not open');
    return (await promise) as RealtimeAck & { data?: any };
  }

  async modifyOrder(orderId: string, order: Record<string, any>, requestId?: string): Promise<RealtimeAck & { data?: any }> {
    if (!this.isOpen()) throw new Error('realtime: socket not open');
    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'modify_order', request_id: rid, correlation_id: rid, order_id: orderId, order })) throw new Error('realtime: socket not open');
    return (await promise) as RealtimeAck & { data?: any };
  }

  async squareOff(position: Record<string, any>, requestId?: string): Promise<RealtimeAck & { data?: any }> {
    if (!this.isOpen()) throw new Error('realtime: socket not open');
    const rid = requestId ?? this.newRequestId();
    const promise = this.track(rid, ACK_TIMEOUT_MS);
    if (!this.sendRaw({ action: 'square_off', request_id: rid, correlation_id: rid, position })) throw new Error('realtime: socket not open');
    return (await promise) as RealtimeAck & { data?: any };
  }

  // ------------------------------------------------------------------ //
  // Inbound
  // ------------------------------------------------------------------ //
  private onMessage(raw: string | Blob) {
    let frame: RealtimeEnvelope;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString();
      frame = JSON.parse(text) as RealtimeEnvelope;
    } catch {
      return;
    }
    const type = frame.type ?? '';
    // WS#3 + WS#4 correlation — frame may carry correlation_id at top-level or inside data
    const requestId = String(frame.request_id ?? frame.correlation_id ?? frame.data?.requestId ?? frame.data?.correlationId ?? '');

    const resolve = (v: any) => {
      const entry = this.pending.get(requestId);
      if (entry) entry.onResolve(v);
    };

    if (type === 'ping') {
      this.sendRaw({ action: 'pong' });
      return;
    }
    if (type === 'pong') {
      return;
    }
    if (type === 'error.event') {
      resolve({ ok: false, requestId, errors: [{ code: frame.data?.code, message: frame.data?.message ?? type }] });
      this.emit(frame);
      return;
    }
    if (type === 'welcome') {
      this.connectionId = String(frame.data?.connectionId ?? this.connectionId);
      this.username = String(frame.data?.username ?? this.username);
      const hb = Number(frame.data?.heartbeatIntervalS ?? 0);
      if (hb > 0) {
        this.heartbeatMs = Math.max(3000, hb * 1000);
        this.startHeartbeat();
      }
      this.emit(frame);
      return;
    }
    if (type === 'subscription.ack') {
      const ok = !Array.isArray(frame.data?.errors) || frame.data.errors.length === 0;
      resolve({ ok, requestId, results: frame.data?.results, errors: frame.data?.errors });
      this.emit(frame);
      return;
    }
    if (type === 'snapshot') {
      const ticks = (frame.data?.ticks ?? []) as any[];
      for (const t of ticks) {
        this.applySnapshotTick(t, frame);
      }
      resolve({ count: ticks.length, ticks, requestId });
      this.emit(frame);
      return;
    }
    if (type.startsWith('market.')) {
      this.onMarketFrame(frame);
      return;
    }
    // WS#4 acknowledgements — resolve pending promises (place/cancel/modify/square-off)
    if (type === 'order.ack' || type === 'square_off.ack' || type === 'square-off.ack' || type.endsWith('.ack')) {
      const ok = frame.data?.ok ?? true;
      resolve({ ok: !!ok, requestId, correlationId: frame.correlation_id ?? frame.data?.correlationId ?? requestId, data: frame.data, result: frame.data?.result });
      this.emit(frame);
      return;
    }
    // Anything else (order.* / trade.* / position.* / notification.* /
    // system.* / connection.*) is forwarded verbatim to listeners.
    this.emit(frame);
  }

  private applySnapshotTick(t: Record<string, any>, source: RealtimeEnvelope) {
    const key = `${t.exchange_segment ?? ''}|${t.instrument_token ?? ''}`;
    const view: RealtimeTickView = {
      key,
      symbol: String(t.symbol ?? t.instrument_token ?? ''),
      instrument_token: String(t.instrument_token ?? ''),
      exchange_segment: String(t.exchange_segment ?? ''),
      channel: String(t.channel ?? '').trim() || 'market',
      ltp: toNum(t.ltp),
      ltq: toNum(t.ltq),
      open: toNum(t.open),
      high: toNum(t.high),
      low: toNum(t.low),
      prevClose: toNum(t.close),
      volume: toNum(t.volume),
      netChange: toNum(t.change),
      netChangePct: toNum(t.changePct),
      avgPrice: toNum(t.avgPrice),
      buy: toNum(t.bid),
      sell: toNum(t.ask),
      receivedAt: t.receivedAt ? String(t.receivedAt) : undefined,
      brokerTimestamp: t.brokerTimestamp ? String(t.brokerTimestamp) : undefined,
      raw: source,
    };
    this.mergeTickView(view);
  }

  private onMarketFrame(frame: RealtimeEnvelope) {
    const data = frame.data ?? {};
    const fields = (data.fields ?? {}) as Record<string, any>;
    const key = `${frame.exchange_segment ?? ''}|${frame.instrument_token ?? ''}`;
    const prev = this.ticks.get(key);
    const view: RealtimeTickView = {
      key,
      symbol: String(frame.symbol ?? prev?.symbol ?? ''),
      instrument_token: String(frame.instrument_token ?? ''),
      exchange_segment: String(frame.exchange_segment ?? ''),
      channel: String(frame.channel ?? prev?.channel ?? 'market'),
      ltp: toNum(fields.ltp),
      ltq: toNum(fields.ltq),
      open: toNum(fields.open),
      high: toNum(fields.high),
      low: toNum(fields.low),
      prevClose: toNum(fields.prev_close),
      volume: toNum(fields.volume),
      netChange: toNum(fields.net_change),
      netChangePct: toNum(fields.net_change_pct),
      avgPrice: toNum(fields.avg_price),
      buy: toNum(fields.buy),
      sell: toNum(fields.sell),
      yearlyHigh: toNum(fields.yearly_high),
      yearlyLow: toNum(fields.yearly_low),
      lastTradeTime: fields.last_trade_time ? String(fields.last_trade_time) : undefined,
      brokerTimestamp: data.brokerTimestamp ? String(data.brokerTimestamp) : undefined,
      receivedAt: data.receivedAt ? String(data.receivedAt) : undefined,
      raw: frame,
    };
    this.mergeTickView(view);
    this.emit(frame);
  }

  /** Latest-value merge: never regress a fresher value with a stale frame. */
  private mergeTickView(view: RealtimeTickView) {
    const prev = this.ticks.get(view.key);
    if (prev) {
      const prevTime = prev.brokerTimestamp ?? prev.receivedAt ?? '';
      const nextTime = view.brokerTimestamp ?? view.receivedAt ?? '';
      if (prevTime && nextTime && String(nextTime) < String(prevTime)) {
        return; // stale frame — keep the newer cached value
      }
      for (const k of [
        'ltp', 'ltq', 'open', 'high', 'low', 'prevClose', 'volume', 'netChange',
        'netChangePct', 'avgPrice', 'buy', 'sell', 'yearlyHigh', 'yearlyLow',
      ] as const) {
        if (view[k] != null) prev[k] = view[k];
      }
      prev.raw = view.raw;
      prev.channel = view.channel || prev.channel;
      prev.receivedAt = view.receivedAt ?? prev.receivedAt;
      prev.brokerTimestamp = view.brokerTimestamp ?? prev.brokerTimestamp;
      prev.lastTradeTime = view.lastTradeTime ?? prev.lastTradeTime;
      if (!prev.symbol) prev.symbol = view.symbol;
      return;
    }
    this.ticks.set(view.key, view);
  }

  private emit(frame: RealtimeEnvelope) {
    for (const cb of this.frameListeners) {
      try {
        cb(frame);
      } catch {
        // listener errors must never break the socket
      }
    }
  }

  // ------------------------------------------------------------------ //
  // Heartbeat (both directions; dropped frames count as dead)
  // ------------------------------------------------------------------ //
  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.isOpen()) {
        this.sendRaw({ action: 'ping' });
      }
    }, this.heartbeatMs > 0 ? this.heartbeatMs : 12000);
  }

  private stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private waitOpen(timeoutMs = WAIT_OPEN_TIMEOUT_MS): Promise<void> {
    if (this.isOpen()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('realtime: waitOpen timed out'));
      }, timeoutMs);
      const off = this.onStateChange((s) => {
        if (s === 'CONNECTED') {
          clearTimeout(timer);
          off();
          resolve();
        } else if (s === 'AUTH_FAILED' || s === 'ERROR') {
          // Don't wait the full timeout when we already know it's stuck —
          // fail fast so callers fall back to polling instead of freezing.
          clearTimeout(timer);
          off();
          reject(new Error(`realtime: stuck in ${s}`));
        }
      });
    });
  }
}

export const realtimeClient = new RealtimeClient();

/** Convenience: fetch a gateway token for /ws/realtime (via the Next proxy). */
export async function getRealtimeToken(): Promise<string> {
  const res = await fetch('/api/realtime/token', { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  return body?.token ?? '';
}