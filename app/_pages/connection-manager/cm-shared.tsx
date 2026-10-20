'use client';

/**
 * Connection Manager — shared data layer, types and UI primitives.
 *
 * docs/engines/connection-manager.md — the authoritative spec.
 * Backend of record: `python-service/connection_engine/connection_engine.py`
 * and `python-service/api/ws_gateway.py`.
 *
 * Every type below mirrors the field names the backend ACTUALLY sends. An
 * earlier revision of these pages read `state` instead of `status` and
 * `timestamp`/`type` instead of `epoch`/`ts`/`eventType`, so entire columns
 * rendered as permanent em-dashes. The types are the contract; if the backend
 * changes, this file must change with it.
 *
 * Spec rules honoured here:
 *   §13 control plane vs data plane — these pages read/inspect only, they never
 *        create, pause or delete a connection.
 *   §22 lifecycle must be observable and diagnosable — everything shown comes
 *        from a backend payload.
 *   §24 control plane is for status/metadata/snapshots, never for tick polling.
 *   RULE 14 requested fields must never be fabricated; RULE 22 diagnosable.
 *   Implementation honesty — a value the backend did not compute renders as
 *        `—` or an explicit `NOT_PROVIDED`, never as a zero or an estimate.
 *
 * Transport: every call goes through the relative Next.js proxy
 * (`/api/realtime/*`, `/api/services/*`) so auth cookies and the configured
 * backend base stay in one place. An earlier revision called
 * `http://127.0.0.1:8000` directly from two pages while the rest used the
 * proxy, which broke auth and CORS whenever the backend moved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useEngineStatus, useOneShot } from '@/lib/engine-realtime';
import { StatusBadge } from '@/components/design-system';

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const CM = {
  /** Engine registry record for the WS#2/WS#3 control plane. */
  engine: '/api/services/engines/connection_manager',
  /** Aggregate health — `connection_engine.health()`. */
  health: '/api/realtime/health',
  /** Bounded event ring — `connection_engine.recent_events()`. */
  events: '/api/realtime/events',
  /** Read-only configuration — `connection_engine.config()`. */
  config: '/api/realtime/config',
  /** Field availability catalogue — `field_requirements.available_fields()`. */
  fields: '/api/realtime/fields',
  /** Live gateway sessions — `connection_engine.status().sessions`. */
  sessions: '/api/realtime/sessions',
  /** Transport ownership map (WS#1..#4, REST, Event Bus). */
  architecture: '/api/realtime/architecture',
  /** Broker order/position feed state (owned by OrderFeedManager, observed only). */
  orderFeed: '/api/realtime/order-feed',
  /** One connection's full diagnostic record. */
  connection: (id: string) => `/api/realtime/connections/${encodeURIComponent(id)}`,
} as const;

// ---------------------------------------------------------------------------
// Types — verbatim backend shapes
// ---------------------------------------------------------------------------

/** `connection_engine.session_records()` row. */
export interface CmConnection {
  connectionId: string;
  consumerId: string;
  consumerType: string;
  channels: string[];
  profiles: string[];
  instruments: number;
  requestedFields: string[];
  fieldStatus: Record<string, string>;
  source: string;
  deliveryMethod: string;
  /** NOTE: the key is `status`, not `state`. */
  status: string;
  lifecycleState: string;
  lastTransitionAt: number | null;
  lastReason: string | null;
  lastActivityAt: number | null;
  lastDeliveredAt: number | null;
  lastError: string | null;
  upSeconds: number | null;
  messagesDelivered: number | null;
  deliveryRatePerSec: number | null;
  queueDepth: number | null;
  queueLimit: number | null;
  messagesDropped: number | null;
  droppedMarket: number | null;
  droppedCritical: number | null;
  username?: string | null;
}

/** `connection_engine.recent_events()` row. */
export interface CmEvent {
  seq: number;
  /** ISO timestamp (IST-aware string from the backend). */
  ts: string;
  /** Epoch seconds — the numeric form used for relative ages. */
  epoch: number;
  level: string;
  /** NOTE: the key is `eventType`, not `type`/`event_type`. */
  eventType: string;
  channel: string;
  connectionId: string;
  eventId: string;
  detail: string;
}

/** `connection_engine._channel_metrics()` value. */
export interface CmChannelMetric {
  kind: string;
  profileId: string;
  priority: string;
  minIntervalS: number | null;
  subscribers: number | null;
  delivered: number | null;
}

/** `connection_engine.health()` payload. */
export interface CmHealth {
  /** A freshness state STRING (spec §56), not an object. */
  feed: string;
  activeConnections: number | null;
  totalConnections: number | null;
  messagesDropped: number | null;
  queueDepthMax: number | null;
  persistErrors: number | null;
  checkedAt: number | null;
  /** STOPPED | ERROR | OVERLOADED | DEGRADED | NO_DATA | HEALTHY */
  state: string;
  reason: string | null;
}

export interface CmBackpressure {
  policy: string;
  queueLimit: number | null;
  queueDepthTotal: number | null;
  queueDepthMax: number | null;
  droppedMarket: number | null;
  droppedCritical: number | null;
}

export interface CmEnginePayload {
  started: boolean;
  startedAt: number | null;
  sessions: number | null;
  framesRouted: number | null;
  marketChannels: string[];
  stateChannels: string[];
  stats: {
    activeConnections: number | null;
    totalConnections: number | null;
    messagesDelivered: number | null;
    messagesDropped: number | null;
    messagesRouted: number | null;
  };
  channelMetrics: Record<string, CmChannelMetric>;
  backpressure: CmBackpressure;
  persistence: { consumerId: string; ticksPersisted: number | null; errors: number | null };
  freshness: { state: string; lastTickAgeSeconds: number | null };
  lifecycle: { engineState: string; connections: Record<string, number> };
  health: CmHealth;
  lastEvents: CmEvent[];
  connectionRegistry: CmConnection[];
}

/** `GET /api/services/engines/connection_manager` → `data`. */
export interface CmEngineRecord {
  engineId: string;
  engineName: string;
  engineCategory: string;
  version: string;
  state: string;
  health: string;
  healthReason: string;
  startedAt: number | null;
  startedAtAgo: number | null;
  lastHeartbeat: number | null;
  heartbeatAge: number | null;
  recentErrors: unknown[];
  dependencies: string[];
  dependents: string[];
  connectionState: string;
  connectionEngine: CmEnginePayload | null;
  diagnostics: {
    status?: Record<string, unknown>;
    health?: CmHealth;
    config?: CmConfig;
  } | null;
}

export interface CmMarketChannel {
  profileId: string;
  priority: string;
  minIntervalS: number | null;
}

export interface CmConfig {
  envelopeVersion: string | number | null;
  schemaVersion: string | number | null;
  heartbeatIntervalS: number | null;
  staleAfterS: number | null;
  channels: {
    market: Record<string, CmMarketChannel>;
    /** State channels are plain description strings, not objects. */
    state: Record<string, string>;
  };
  fieldSources: {
    sources: string[];
    ws: string[];
    features: string[];
    aliases: Record<string, string>;
  };
  freshnessThresholds: { freshMaxAgeS: number | null; delayedMaxAgeS: number | null };
  backpressure: { policy: string; queueLimit: number | null };
  deliveryMethods: string[];
  consumerTypes: string[];
}

export interface CmFields {
  sources: string[];
  ws: string[];
  features: string[];
  aliases: Record<string, string>;
}

export interface CmSession {
  connectionId: string;
  username?: string | null;
  channels: string[];
  upSeconds: number | null;
  outboxSize: number | null;
  ticksSent: number | null;
  framesSent: number | null;
  droppedMarket: number | null;
  droppedCritical: number | null;
}

/** Heterogeneous by design — each transport reports only the keys it has. */
export interface CmArchitectureEntry {
  direction?: string;
  owner?: string;
  purpose?: string;
  connected?: boolean;
  state?: string;
  sessions?: number;
  framesRouted?: number;
  endpoint?: string;
  implementation?: string;
}

export type CmArchitecture = Record<string, CmArchitectureEntry>;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Live engine payload. `source` distinguishes a realtime frame from the
 * one-shot REST fallback so the UI can label the data's provenance honestly
 * instead of implying a live feed it does not have.
 */
export function useConnectionManagerEngine(): {
  engine: CmEngineRecord | null;
  payload: CmEnginePayload | null;
  error: string | null;
  source: 'api' | 'realtime' | null;
  connected: boolean;
  updatedAt: number | null;
  refresh: () => void;
} {
  const { data, error, source, connected, updatedAt, refresh } = useEngineStatus<CmEngineRecord>(
    'connection_manager',
    CM.engine,
  );
  return {
    engine: data ?? null,
    payload: data?.connectionEngine ?? null,
    error,
    source,
    connected,
    updatedAt,
    refresh,
  };
}

/** All secondary read-only surfaces in one hook, so pages stay declarative. */
export function useConnectionManagerData(): {
  engine: CmEngineRecord | null;
  payload: CmEnginePayload | null;
  health: CmHealth | null;
  events: CmEvent[];
  config: CmConfig | null;
  fields: CmFields | null;
  sessions: CmSession[] | null;
  architecture: CmArchitecture | null;
  orderFeed: Record<string, unknown> | null;
  errors: string[];
  loading: boolean;
  source: 'api' | 'realtime' | null;
  connected: boolean;
  updatedAt: number | null;
  reload: () => void;
} {
  const eng = useConnectionManagerEngine();
  const health = useOneShot<CmHealth>(CM.health);
  const events = useOneShot<{ events: CmEvent[] }>(CM.events);
  const config = useOneShot<CmConfig>(CM.config);
  const fields = useOneShot<CmFields>(CM.fields);
  const sessions = useOneShot<CmSession[]>(CM.sessions);
  const architecture = useOneShot<CmArchitecture>(CM.architecture);
  const orderFeed = useOneShot<Record<string, unknown>>(CM.orderFeed);

  const errors = useMemo(() => {
    const out: string[] = [];
    if (eng.error) out.push(`engine: ${eng.error}`);
    if (health.error) out.push(`health: ${health.error}`);
    if (events.error) out.push(`events: ${events.error}`);
    if (config.error) out.push(`config: ${config.error}`);
    if (fields.error) out.push(`fields: ${fields.error}`);
    if (sessions.error) out.push(`sessions: ${sessions.error}`);
    if (architecture.error) out.push(`architecture: ${architecture.error}`);
    if (orderFeed.error) out.push(`order feed: ${orderFeed.error}`);
    return out;
  }, [eng.error, health.error, events.error, config.error, fields.error, sessions.error, architecture.error, orderFeed.error]);

  const loading =
    !eng.engine &&
    !errors.length;

  const reload = useCallback(() => {
    eng.refresh();
    health.refresh();
    events.refresh();
    config.refresh();
    fields.refresh();
    sessions.refresh();
    architecture.refresh();
    orderFeed.refresh();
  }, [eng, health, events, config, fields, sessions, architecture, orderFeed]);

  return {
    engine: eng.engine,
    payload: eng.payload,
    health: health.data,
    events: events.data?.events ?? [],
    config: config.data,
    fields: fields.data,
    sessions: sessions.data,
    architecture: architecture.data,
    orderFeed: orderFeed.data,
    errors,
    loading,
    source: eng.source,
    connected: eng.connected,
    updatedAt: eng.updatedAt,
    reload,
  };
}

/** Debounced value — the event filters must not fire a request per keystroke. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Polls `reload` on an interval ONLY when the user turns auto-refresh on and
 * the tab is visible. Spec §24 is explicit that the control plane must not be
 * tick-polled, so the default is OFF: the realtime engine frame is the primary
 * source and this is a manual safety net for the secondary REST surfaces.
 *
 * `secondsLeft` drives the countdown ring in the header. Visibility is handled
 * via the `visibilitychange` event, and the interval never stacks on itself.
 */
export function useAutoRefresh(reload: () => void, intervalMs = 15000) {
  const [enabled, setEnabled] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(intervalMs / 1000));
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!enabled) {
      setSecondsLeft(Math.round(intervalMs / 1000));
      return;
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') reloadRef.current();
    };
    document.addEventListener('visibilitychange', onVis);
    const tick = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? Math.round(intervalMs / 1000) : s - 1));
    }, 1000);
    const poll = setInterval(() => reloadRef.current(), intervalMs);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [enabled, intervalMs]);

  return { enabled, setEnabled, secondsLeft, progress: 1 - secondsLeft / Math.max(1, Math.round(intervalMs / 1000)) };
}

/**
 * Bounded client-side ring of samples for a numeric metric, so a tile can show
 * a real trend of what the backend reported across pushes. Bounded at
 * `capacity` so a long-lived tab cannot grow without limit.
 */
export function useHistorySeries(capacity = 24) {
  const ref = useRef<Record<string, number[]>>({});
  return useCallback((key: string, value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return;
    const list = ref.current[key] ?? [];
    const next = [...list, value];
    ref.current[key] = next.length > capacity ? next.slice(next.length - capacity) : next;
  }, [capacity]);
}

/** Returns the stored series without mutating it (for render). */
export function readHistorySeries(
  ref: React.MutableRefObject<Record<string, number[]>>,
  key: string,
): number[] {
  return ref.current[key] ?? [];
}

/** Re-renders once per second so "3.2 s ago" labels stay truthful. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** One connection's diagnostic record, fetched per selection. */
export function useConnectionDetail(connectionId: string | null): {
  detail: CmConnection | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
} {
  const [detail, setDetail] = useState<CmConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!connectionId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(CM.connection(connectionId), { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setDetail(null);
        return;
      }
      setDetail((body.data ?? null) as CmConnection | null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { detail, error, loading, reload: load };
}

// ---------------------------------------------------------------------------
// Formatters — IST-pinned
// ---------------------------------------------------------------------------

export const IST = 'Asia/Kolkata';
export const DASH = '—';
/** Rendered when the backend does not expose a value at all. Never a zero. */
export const NOT_PROVIDED = 'NOT_PROVIDED';

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return String(v);
}

/** Epoch seconds → IST wall clock. Explicit timezone: never the browser's. */
export function fmtClock(epoch: number | null | undefined): string {
  if (epoch == null || !Number.isFinite(epoch)) return DASH;
  try {
    return new Date(epoch * 1000).toLocaleTimeString('en-GB', {
      timeZone: IST,
      hour12: false,
    });
  } catch {
    return DASH;
  }
}

export function fmtDateTime(epoch: number | null | undefined): string {
  if (epoch == null || !Number.isFinite(epoch)) return DASH;
  try {
    return new Date(epoch * 1000).toLocaleString('en-GB', {
      timeZone: IST,
      hour12: false,
    });
  } catch {
    return DASH;
  }
}

/** Parse the backend's ISO `ts`, which is already IST-aware. */
export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  try {
    return new Date(parsed).toLocaleString('en-GB', { timeZone: IST, hour12: false });
  } catch {
    return iso;
  }
}

/** "120 ms ago" / "3.2 s ago" / "4 min ago" — spec §50 uses this shape. */
export function fmtAgo(epoch: number | null | undefined, now = Date.now() / 1000): string {
  if (epoch == null || !Number.isFinite(epoch)) return DASH;
  const deltaMs = (now - epoch) * 1000;
  if (deltaMs < 0) return 'just now';
  const s = deltaMs / 1000;
  if (s < 1) return `${Math.round(deltaMs)} ms ago`;
  if (s < 60) return `${s.toFixed(1)} s ago`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} min ago`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)} h ago`;
  return `${(h / 24).toFixed(1)} d ago`;
}

export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(2)} msg/sec`;
}

export function fmtSeconds(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${v.toFixed(v < 10 ? 1 : 0)}s`;
}

export function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return `${Math.round(v)} ms`;
}

export function fmtBytes(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Tone vocabularies — driven by the backend's own enumerations
// ---------------------------------------------------------------------------

type BadgeStatus = React.ComponentProps<typeof StatusBadge>['status'];

/** `health().state`: STOPPED | ERROR | OVERLOADED | DEGRADED | NO_DATA | HEALTHY */
export function healthTone(state: string | null | undefined): BadgeStatus {
  switch ((state ?? '').toUpperCase()) {
    case 'HEALTHY':
      return 'success';
    case 'DEGRADED':
    case 'OVERLOADED':
      return 'warning';
    case 'ERROR':
      return 'danger';
    case 'NO_DATA':
      return 'info';
    case 'STOPPED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** Spec §56 freshness: FRESH | DELAYED | STALE | NO_DATA. */
export function freshnessTone(state: string | null | undefined): BadgeStatus {
  switch ((state ?? '').toUpperCase()) {
    case 'FRESH':
      return 'success';
    case 'DELAYED':
      return 'warning';
    case 'STALE':
      return 'danger';
    case 'NO_DATA':
      return 'info';
    default:
      return 'neutral';
  }
}

/**
 * Spec §23 connection state -> severity. Only the states the spec names
 * (§23, §20) are classified; anything unknown stays neutral rather than being
 * guessed into a good or bad answer.
 */
export function connectionTone(status: string | null | undefined): BadgeStatus {
  switch ((status ?? '').toUpperCase()) {
    case 'ACTIVE':
    case 'READY':
    case 'CONNECTED':
      return 'success';
    case 'DEGRADED':
    case 'EXPIRING':
    case 'PAUSED':
    case 'RECONNECTING':
    case 'CONNECTING':
    case 'DISCONNECTING':
      return 'warning';
    case 'FAILED':
    case 'EXPIRED':
    case 'TERMINATED':
      return 'danger';
    case 'CREATED':
    case 'VALIDATING':
    case 'WAITING_FOR_SOURCE':
    case 'WAITING_FOR_INSTRUMENT':
    case 'WAITING_FOR_FEATURES':
      return 'info';
    case 'DISCONNECTED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function levelTone(level: string | null | undefined): BadgeStatus {
  switch ((level ?? '').toLowerCase()) {
    case 'error':
    case 'critical':
    case 'fatal':
      return 'danger';
    case 'warn':
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    default:
      return 'neutral';
  }
}

/** Spec §23's terminal states — a connection in one of these is not "alive". */
export const TERMINAL_CONNECTION_STATES = new Set([
  'TERMINATED',
  'FAILED',
  'EXPIRED',
  'DISCONNECTED',
]);

export function isAlive(status: string | null | undefined): boolean {
  return !TERMINAL_CONNECTION_STATES.has((status ?? '').toUpperCase());
}

// ---------------------------------------------------------------------------
// Derived spec §51 aggregates
//
// Every metric is either read directly or derived from a value the backend
// actually sent. Two spec metrics have NO backend source and are reported as
// `NOT_PROVIDED` rather than invented — see `CM_AGGREGATES`.
// ---------------------------------------------------------------------------

export interface CmAggregate {
  key: string;
  label: string;
  value: string;
  /** Where the number came from — shown in the UI so a derived value is never
   *  mistaken for a directly reported one. */
  source: 'reported' | 'derived' | 'not-provided';
  detail?: string;
}

export function buildAggregates(
  payload: CmEnginePayload | null,
  health: CmHealth | null,
  config: CmConfig | null,
): CmAggregate[] {
  const stats = payload?.stats;
  const life = payload?.lifecycle?.connections ?? {};
  const registry = payload?.connectionRegistry ?? [];
  const staleAfterS = config?.staleAfterS ?? null;
  const now = Date.now() / 1000;

  const inState = (s: string) => life[s] ?? 0;

  // messages/sec: the backend reports a per-connection delivery rate, so the
  // aggregate is the sum of real measured rates.
  const msgPerSec = registry.reduce(
    (acc, c) => acc + (typeof c.deliveryRatePerSec === 'number' && Number.isFinite(c.deliveryRatePerSec) ? c.deliveryRatePerSec : 0),
    0,
  );

  const consumers = new Set(registry.map((c) => c.consumerId).filter(Boolean));

  // Stale = the connection's last activity is older than the configured
  // staleAfterS threshold. Uses the real threshold, never a guess.
  const staleCount =
    staleAfterS == null
      ? null
      : registry.filter((c) => (c.lastActivityAt ?? 0) < now - staleAfterS).length;

  const avgDeliveryLatency = null; // spec §51 asks for it; backend exposes none

  return [
    { key: 'total', label: 'Total connections', value: fmtNum(stats?.totalConnections ?? health?.totalConnections ?? null), source: 'reported' },
    { key: 'active', label: 'Active connections', value: fmtNum(stats?.activeConnections ?? health?.activeConnections ?? null), source: 'reported' },
    { key: 'paused', label: 'Paused connections', value: fmtNum(inState('PAUSED')), source: 'derived', detail: 'from lifecycle state map' },
    { key: 'failed', label: 'Failed connections', value: fmtNum(inState('FAILED')), source: 'derived', detail: 'from lifecycle state map' },
    { key: 'expired', label: 'Expired connections', value: fmtNum(inState('EXPIRED')), source: 'derived', detail: 'from lifecycle state map' },
    { key: 'reconnecting', label: 'Reconnecting connections', value: fmtNum(inState('RECONNECTING')), source: 'derived', detail: 'from lifecycle state map' },
    { key: 'consumers', label: 'Consumers connected', value: fmtNum(consumers.size), source: 'derived', detail: 'distinct consumerId in registry' },
    { key: 'msgRate', label: 'Messages / sec', value: registry.length ? msgPerSec.toFixed(2) : DASH, source: 'derived', detail: 'sum of per-connection deliveryRatePerSec' },
    { key: 'bytesRate', label: 'Bytes / sec', value: NOT_PROVIDED, source: 'not-provided', detail: 'backend exposes no byte counter' },
    { key: 'deliveryLatency', label: 'Average delivery latency', value: avgDeliveryLatency === null ? NOT_PROVIDED : DASH, source: 'not-provided', detail: 'backend exposes no latency histogram' },
    { key: 'queueDepthMax', label: 'Maximum queue depth', value: fmtNum(payload?.backpressure?.queueDepthMax ?? health?.queueDepthMax ?? null), source: 'reported' },
    { key: 'dropped', label: 'Dropped message count', value: fmtNum(stats?.messagesDropped ?? health?.messagesDropped ?? null), source: 'reported' },
    {
      key: 'stale',
      label: 'Stale connection count',
      value: staleCount === null ? NOT_PROVIDED : fmtNum(staleCount),
      source: staleCount === null ? 'not-provided' : 'derived',
      detail: staleAfterS == null ? 'no staleAfterS threshold' : `last activity older than ${staleAfterS}s`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------

/** Label/value row. Renders an em-dash for a missing value — never a zero. */
export function KV({ label, value, tone, mono = true }: {
  label: string;
  value: ReactNode;
  tone?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className={`truncate text-right text-[11px] ${mono ? 'font-mono' : ''} ${tone ?? 'text-foreground'}`}>
        {value ?? DASH}
      </span>
    </div>
  );
}

export function KVGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const map = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' };
  return <div className={`grid grid-cols-1 gap-x-6 gap-y-1 ${map[cols]}`}>{children}</div>;
}

/**
 * One spec §51 aggregate. The provenance tag is deliberate: a derived or
 * unavailable metric must never look like a directly reported one.
 */
export function AggregateTile({ item }: { item: CmAggregate }) {
  const tone =
    item.source === 'not-provided'
      ? 'text-muted-foreground'
      : item.key === 'dropped' && item.value !== DASH && Number(item.value.replace(/,/g, '')) > 0
        ? 'text-warning'
        : item.key === 'stale' && item.value !== DASH && Number(item.value) > 0
          ? 'text-destructive'
          : 'text-foreground';
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{item.label}</span>
        {item.source !== 'reported' ? (
          <span
            title={item.detail}
            className="shrink-0 rounded border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
          >
            {item.source === 'derived' ? 'derived' : 'absent'}
          </span>
        ) : null}
      </div>
      <div className={`mt-1 font-mono text-sm tabular-nums ${tone}`}>{item.value}</div>
      {item.source !== 'reported' && item.detail ? (
        <div className="truncate text-[9px] text-muted-foreground/70" title={item.detail}>
          {item.detail}
        </div>
      ) : null}
    </div>
  );
}

export function Chip({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-xs tabular-nums ${tone ?? ''}`}>{value ?? DASH}</div>
    </div>
  );
}

/** Small pill list for field names, channels, profiles. */
export function TokenList({ values, empty = 'none', max = 40 }: {
  values: string[] | undefined | null;
  empty?: string;
  max?: number;
}) {
  if (!values?.length) {
    return <span className="text-[11px] text-muted-foreground">{empty}</span>;
  }
  const shown = values.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((v) => (
        <span
          key={v}
          className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {v}
        </span>
      ))}
      {values.length > max ? (
        <span className="text-[10px] text-muted-foreground">+{values.length - max} more</span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Interaction helpers — copy/export, sortable tables
// ---------------------------------------------------------------------------

/**
 * Clipboard write with a short "copied" acknowledgement. Falls back silently:
 * clipboard access can be denied, and a diagnostic page must not throw because
 * of a permission prompt.
 */
export function useCopy(resetMs = 1600): {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      let ok = false;
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (ok) {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      }
      return ok;
    },
    [resetMs],
  );

  return { copied, copy };
}

/** Triggers a client-side file download of a JSON snapshot (no server round-trip). */
export function downloadJson(filename: string, value: unknown) {
  try {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

export type SortDir = 'asc' | 'desc';

/**
 * Generic client-side sorter. `accessor` pulls the comparable value out of a
 * row; `null`/`NaN` always sorts last regardless of direction so "no data"
 * never masquerades as the biggest or smallest number.
 */
export function useSortState<K extends string>(initial: K, initialDir: SortDir = 'desc') {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<SortDir>(initialDir);

  const toggle = useCallback(
    (next: K) => {
      if (next === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setKey(next);
        setDir('desc');
      }
    },
    [key],
  );

  const sort = useCallback(
    <T,>(rows: T[], accessors: Record<K, (r: T) => number | string | null | undefined>) => {
      const acc = accessors[key];
      if (!acc) return rows;
      const sorted = [...rows].sort((a, b) => {
        const av = acc(a);
        const bv = acc(b);
        const aBad = av == null || (typeof av === 'number' && !Number.isFinite(av));
        const bBad = bv == null || (typeof bv === 'number' && !Number.isFinite(bv));
        if (aBad && bBad) return 0;
        if (aBad) return 1;
        if (bBad) return -1;
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv));
        return dir === 'asc' ? cmp : -cmp;
      });
      return sorted;
    },
    [key, dir],
  );

  return { key, dir, toggle, sort, indicator: (k: K) => (k === key ? (dir === 'asc' ? '▲' : '▼') : '') };
}
