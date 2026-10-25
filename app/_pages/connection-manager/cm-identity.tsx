'use client';

/**
 * Connection Manager — connection identity.
 *
 * The registry sends machine tokens (`UI`, `ws_engine`, `WEBSOCKET`, `CREATED`).
 * Spec §50 asks the page to answer "who connected, when, and why", and a raw
 * token cannot answer that, so this module maps each backend enum onto a proper
 * human label plus a one-line explanation of what that value actually means.
 *
 * The mapping tables are exhaustive over the vocabularies the backend emits
 * (verified against `connection_engine/client.py`, `field_requirements.py` and
 * `services/connection_manager_engine.py`). An unrecognised token is passed
 * through verbatim and flagged `known: false` — the page shows it as-is rather
 * than guessing a meaning for a value the backend has since added.
 *
 * HONESTY RULE: nothing here invents data. "Connected at" is derived from the
 * backend's own `upSeconds`, and every derived value is tagged `derived: true`
 * so the UI can label it as computed rather than reported.
 */

import type { CmConnection } from './cm-shared';

// ---------------------------------------------------------------------------
// Proper-name vocabulary
// ---------------------------------------------------------------------------

export interface ProperName {
  /** Human title, e.g. "Trading Terminal". */
  label: string;
  /** What this value actually means in the pipeline. */
  blurb: string;
  /** Whether the backend's vocabulary is covered by this table. */
  known: boolean;
  /** Lucide icon name resolved by the page (kept as a string to stay data-only). */
  icon?: string;
}

/**
 * `consumerTypes` — `connection_manager_engine.py` line 62 declares
 * UI, STRATEGY, MODEL, MARKET_COACH, WATCHLIST, ALERT, ANALYTICS.
 * The gateway currently stamps every session `UI`, but the vocabulary is real
 * and other producers (WS#4 command router) can carry the rest.
 */
const CONSUMER_TYPES: Record<string, ProperName> = {
  UI: {
    label: 'Trading Terminal',
    blurb: 'Browser session that subscribes over the realtime gateway.',
    known: true,
    icon: 'MonitorSmartphone',
  },
  STRATEGY: {
    label: 'Strategy Runner',
    blurb: 'Automated strategy process consuming live ticks.',
    known: true,
    icon: 'Bot',
  },
  MODEL: {
    label: 'ML / Model Service',
    blurb: 'Model inference consumer reading feature output.',
    known: true,
    icon: 'BrainCircuit',
  },
  MARKET_COACH: {
    label: 'Market Coach',
    blurb: 'Advisory consumer of derived market signals.',
    known: true,
    icon: 'Lightbulb',
  },
  WATCHLIST: {
    label: 'Watchlist Service',
    blurb: 'Background watchlist monitor on subscribed instruments.',
    known: true,
    icon: 'ListChecks',
  },
  ALERT: {
    label: 'Alert Engine',
    blurb: 'Notification consumer bound to rule triggers.',
    known: true,
    icon: 'BellRing',
  },
  ANALYTICS: {
    label: 'Analytics Pipeline',
    blurb: 'Batch/streaming analytics consumer.',
    known: true,
    icon: 'BarChart3',
  },
  DATA_SAVER: {
    label: 'Data Saver',
    blurb: 'Persistence consumer that drains ticks to storage.',
    known: true,
    icon: 'HardDriveDownload',
  },
};

/**
 * `source` — `connection_engine.py`: `SOURCE_WS_ENGINE = "ws_engine"`,
 * `SOURCE_FEATURE = "feature_engine"`. Chosen per-session by whether any
 * channel resolved field requirements (feature output present → feature engine).
 */
const SOURCES: Record<string, ProperName> = {
  ws_engine: {
    label: 'WebSocket Engine (WS#1)',
    blurb: 'Raw canonical market stream relayed from the broker socket.',
    known: true,
    icon: 'Radio',
  },
  feature_engine: {
    label: 'Feature Engine',
    blurb: 'Computed feature output — VWAP, SMA, change, spread.',
    known: true,
    icon: 'Cpu',
  },
  MARKET_DATA_WEBSOCKET: {
    label: 'Market Data WebSocket',
    blurb: 'Canonical broker market stream.',
    known: true,
    icon: 'Radio',
  },
  FEATURE_ENGINE: {
    label: 'Feature Engine',
    blurb: 'Computed feature output.',
    known: true,
    icon: 'Cpu',
  },
};

/** `deliveryMethod` — config advertises `["WEBSOCKET"]`. */
const DELIVERY_METHODS: Record<string, ProperName> = {
  WEBSOCKET: {
    label: 'WebSocket (WS#3)',
    blurb: 'Pushed frames on the Backend → Frontend socket.',
    known: true,
    icon: 'Waypoints',
  },
  internal_stream: {
    label: 'Internal Stream',
    blurb: 'In-process delivery without a socket hop.',
    known: true,
    icon: 'Zap',
  },
  snapshot: {
    label: 'Snapshot',
    blurb: 'One-shot REST snapshot rather than a live frame.',
    known: true,
    icon: 'Camera',
  },
};

/** Spec §23 lifecycle — `client.py` CREATED → CONNECTING → ACTIVE → DISCONNECTING → TERMINATED. */
const LIFECYCLE_STATES: Record<string, ProperName> = {
  CREATED: { label: 'Created', blurb: 'Session object exists, socket not yet accepted.', known: true },
  CONNECTING: { label: 'Connecting', blurb: 'Socket accepted, fan-out loop starting.', known: true },
  ACTIVE: { label: 'Active', blurb: 'Fan-out loop running and delivering frames.', known: true },
  DISCONNECTING: { label: 'Disconnecting', blurb: 'Tearing down, queue draining.', known: true },
  TERMINATED: { label: 'Terminated', blurb: 'Session closed — no further delivery.', known: true },
};

/** Spec §10 field availability — `field_requirements.py`. */
const FIELD_STATUSES: Record<string, ProperName> = {
  AVAILABLE: { label: 'Available', blurb: 'Resolved from the canonical stream or Feature Engine.', known: true },
  UNAVAILABLE: { label: 'Unavailable', blurb: 'No upstream source produces this field.', known: true },
  PARTIAL: { label: 'Partial', blurb: 'Some requested fields resolve, others do not.', known: true },
  NOT_READY: { label: 'Not Ready', blurb: 'Produced upstream but not yet computed (warm-up).', known: true },
  SOURCE_ERROR: { label: 'Source Error', blurb: 'The upstream source is not running or errored.', known: true },
};

/** Channel name → what a consumer subscribed for. */
const CHANNEL_PURPOSE: Record<string, string> = {
  watchlist: 'Watchlist quotes for saved instruments',
  market_watch: 'Live market watch grid',
  trading: 'Order-book / trading depth stream',
  ai: 'AI model signal stream',
  positions: 'Live position updates',
  orders: 'Order lifecycle updates',
  notifications: 'System + trade notifications',
  system: 'System state broadcast',
  data: 'Data-saver tick stream',
  engines: 'Engine registry snapshots',
};

/**
 * The event vocabulary the gateway ACTUALLY emits — every `_log_event` call
 * site in `connection_engine.py`. Spec §39's speculative 23-event model is not
 * implemented, so no entry here describes an event the backend cannot produce.
 */
const EVENT_TYPES: Record<string, ProperName> = {
  'engine.started': { label: 'Engine Started', blurb: 'Gateway came online on WS#2.', known: true, icon: 'Play' },
  'engine.stopped': { label: 'Engine Stopped', blurb: 'Gateway went offline.', known: true, icon: 'Power' },
  'session.attached': { label: 'Session Attached', blurb: 'A consumer session registered with the gateway.', known: true, icon: 'LogIn' },
  'session.detached': { label: 'Session Detached', blurb: 'A consumer session was removed.', known: true, icon: 'LogOut' },
  'subscription.acked': { label: 'Subscription Acked', blurb: 'Channel subscription resolved; detail carries added/errors.', known: true, icon: 'CheckCheck' },
  'subscription.removed': { label: 'Subscription Removed', blurb: 'A channel subscription was dropped.', known: true, icon: 'CheckMinus' },
  'fanout.batch': { label: 'Fan-out Batch', blurb: 'A batch of frames was routed to a consumer.', known: true, icon: 'Send' },
  'fanout.failed': { label: 'Fan-out Failed', blurb: 'Routing a batch to a consumer raised an error.', known: true, icon: 'AlertTriangle' },
  'broadcast.delivered': { label: 'Broadcast Delivered', blurb: 'A channel-wide broadcast was delivered.', known: true, icon: 'Radio' },
  'persistence.written': { label: 'Persistence Written', blurb: 'Ticks were drained to storage by the data saver.', known: true, icon: 'Database' },
  'persistence.failed': { label: 'Persistence Failed', blurb: 'The persistence loop raised an error.', known: true, icon: 'DatabaseZap' },
  'outbox.dropped': { label: 'Outbox Dropped', blurb: 'A slow consumer overflowed its bounded queue.', known: true, icon: 'Trash2' },
};

/** Delivery priority `P0`–`P3` → what it means for delivery latency. */
const PRIORITIES: Record<string, ProperName> = {
  P0: { label: 'P0 · Critical', blurb: 'Highest delivery priority — lowest throttle.', known: true },
  P1: { label: 'P1 · High', blurb: 'Trading-critical delivery.', known: true },
  P2: { label: 'P2 · Normal', blurb: 'Standard delivery cadence.', known: true },
  P3: { label: 'P3 · Background', blurb: 'Best-effort background delivery.', known: true },
};

/** Field-profile ids used by market channels (`channels.py`). */
const PROFILES: Record<string, ProperName> = {
  WATCHLIST_LIGHT: { label: 'Watchlist (light)', blurb: 'Thin projection for watchlist-style consumers.', known: true },
  POSITION_CRITICAL: { label: 'Position (critical)', blurb: 'Full position-critical projection.', known: true },
  AI_HIGH: { label: 'AI (high)', blurb: 'Feature-rich projection for model consumers.', known: true },
  FULL_RAW: { label: 'Full raw', blurb: 'Unfiltered canonical stream.', known: true },
};

/** Backpressure policy names. */
const POLICIES: Record<string, ProperName> = {
  DROP_OLDEST: {
    label: 'Drop Oldest',
    blurb: 'On overflow the oldest queued item is discarded so a slow consumer never stalls the pipeline (spec §26).',
    known: true,
  },
  BLOCK: { label: 'Block', blurb: 'Producer waits until the queue drains.', known: true },
  REJECT: { label: 'Reject', blurb: 'New items are rejected on overflow.', known: true },
};

export const eventTypeName = (t: string | null | undefined) => lookup(EVENT_TYPES, t);
export const priorityName = (t: string | null | undefined) => lookup(PRIORITIES, t);
export const profileName = (t: string | null | undefined) => lookup(PROFILES, t);
export const policyName = (t: string | null | undefined) => lookup(POLICIES, t);

/** Every event type the backend can emit — used for the filter dropdown. */
export const ALL_EVENT_TYPES = Object.keys(EVENT_TYPES);

/** What a catalogue group of fields is for (spec §10). */
export const FIELD_GROUP_INFO = {
  ws: {
    label: 'Market Data Fields',
    blurb: 'Canonical broker fields carried on WS#1 (SFeed).',
    tone: 'info' as const,
  },
  features: {
    label: 'Feature Engine Fields',
    blurb: 'Computed features resolved by the Feature Engine.',
    tone: 'purple' as const,
  },
  aliases: {
    label: 'Field Aliases',
    blurb: 'Spec §24 — alternate names mapped onto a canonical field.',
    tone: 'teal' as const,
  },
} as const;

/**
 * Heuristic for "what kind of field is this?" used only to group the catalogue
 * visually. It reads the NAME the backend published and never asserts that a
 * field resolves — availability is the resolver's verdict (spec §10), so this
 * page never shows one.
 */
export function fieldKindHint(field: string): string | null {
  const f = field.toLowerCase();
  if (/(^|_)(oi|c bid|bid|ask|depth|imbalance|spread|ltp|vol|oi)$/.test(f)) return 'market';
  if (/^(vwap|sma|ema|change|changepercent|macd|rsi|atr|bb_)/.test(f)) return 'feature';
  if (/(ts|timestamp|epoch|seq)/.test(f)) return 'time';
  if (/(status|state|health|error|reason)/.test(f)) return 'state';
  return null;
}

function lookup(table: Record<string, ProperName>, token: string | null | undefined): ProperName | null {
  const t = (token ?? '').trim();
  if (!t) return null;
  const hit = table[t.toUpperCase()] ?? table[t];
  if (hit) return hit;
  return { label: t, blurb: 'Value not in the known backend vocabulary — shown verbatim.', known: false };
}

export const consumerTypeName = (t: string | null | undefined) => lookup(CONSUMER_TYPES, t);
export const sourceName = (t: string | null | undefined) => lookup(SOURCES, t);
export const deliveryMethodName = (t: string | null | undefined) => lookup(DELIVERY_METHODS, t);
export const lifecycleStateName = (t: string | null | undefined) => lookup(LIFECYCLE_STATES, t);
export const fieldStatusName = (t: string | null | undefined) => lookup(FIELD_STATUSES, t);
export const channelPurpose = (c: string) => CHANNEL_PURPOSE[c] ?? null;

/** Every consumer type the backend declares, for the filter dropdown. */
export const ALL_CONSUMER_TYPES = Object.keys(CONSUMER_TYPES);

// ---------------------------------------------------------------------------
// WHO — who is this connection?
// ---------------------------------------------------------------------------

export interface ConnectionIdentity {
  /** Best available human name for the consumer. */
  displayName: string;
  /** True when the backend gave us an authenticated principal, not "anonymous". */
  authenticated: boolean;
  /** The authenticated principal (JWT `sub`) or the literal "anonymous". */
  principal: string;
  /** Secondary line: what kind of thing this consumer is. */
  roleLabel: string;
  roleBlurb: string;
  roleKnown: boolean;
  /** Two-letter avatar initials. */
  initials: string;
  /** Unique short id for the avatar hue, derived from the consumer id. */
  hueSeed: number;
  /** Masked-but-stable id, e.g. `a3f9…c21b`. */
  shortId: string;
  /** Full id, shown on expand. */
  fullId: string;
}

export function identityOf(c: CmConnection): ConnectionIdentity {
  const principal = (c.username ?? '').trim() || 'anonymous';
  const authenticated = principal.toLowerCase() !== 'anonymous';
  const consumerId = (c.consumerId || c.connectionId || '').trim();
  const role = consumerTypeName(c.consumerType);

  // Prefer the authenticated principal as the display name; fall back to the
  // consumer id so the row is still identifiable for anonymous sessions.
  const displayName = authenticated ? principal : shortId(consumerId) || 'anonymous session';

  return {
    displayName,
    authenticated,
    principal,
    roleLabel: role?.label ?? (c.consumerType || 'Unknown consumer'),
    roleBlurb: role?.blurb ?? 'Consumer type not declared by the backend.',
    roleKnown: role?.known ?? false,
    initials: initialsOf(authenticated ? principal : consumerId || '?'),
    hueSeed: hueOf(consumerId || displayName),
    shortId: shortId(consumerId),
    fullId: consumerId,
  };
}

function initialsOf(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) return '?';
  if (cleaned.length === 1) return cleaned.toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

/** Stable 8-char mask of a uuid-ish id: first 4 … last 4. */
export function shortId(id: string | null | undefined): string {
  const v = (id ?? '').trim();
  if (!v) return '';
  if (v.length <= 10) return v;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}

/** Avatar palette driven by the consumer id, so one consumer keeps one colour. */
export function avatarStyle(seed: number): React.CSSProperties {
  return {
    background: `hsl(${seed} 70% 50% / 0.16)`,
    borderColor: `hsl(${seed} 70% 50% / 0.4)`,
    color: `hsl(${seed} 75% 62%)`,
  };
}

// ---------------------------------------------------------------------------
// WHEN — when did it connect, and when did it last do anything?
// ---------------------------------------------------------------------------

export interface ConnectionTimeline {
  /** Epoch seconds the session attached, derived from the backend's upSeconds. */
  connectedAt: number | null;
  connectedAtDerived: boolean;
  /** Epoch seconds of the last lifecycle transition (backend-reported). */
  lastTransitionAt: number | null;
  /** Epoch seconds of the last delivery (backend-reported). */
  lastDeliveredAt: number | null;
  /** Epoch seconds of the last activity of any kind (backend-reported). */
  lastActivityAt: number | null;
  /** Why the last transition happened (backend-reported free text). */
  lastReason: string | null;
  /** Steps for the rendered timeline; empty entries are omitted. */
  steps: TimelineStep[];
}

export interface TimelineStep {
  at: number | null;
  title: string;
  detail: string;
  tone: 'muted' | 'success' | 'info' | 'warning' | 'danger';
}

export function timelineOf(c: CmConnection, now: number): ConnectionTimeline {
  // `upSeconds` is backend-reported; the attach instant is `now - upSeconds`.
  // This is arithmetic on a real value, not an invention, and it is flagged.
  const connectedAt =
    c.upSeconds != null && Number.isFinite(c.upSeconds) ? now - c.upSeconds : null;

  const steps: TimelineStep[] = [];
  steps.push({
    at: connectedAt,
    title: 'Attached to gateway',
    detail: c.lastReason ?? 'Session accepted on WS#3.',
    tone: 'info',
  });
  if (c.lastTransitionAt != null) {
    steps.push({
      at: c.lastTransitionAt,
      title: c.lifecycleState || 'State transition',
      detail: c.lastReason ?? 'Lifecycle transition recorded.',
      tone: lifecycleTone(c.lifecycleState),
    });
  }
  if (c.lastDeliveredAt != null) {
    steps.push({
      at: c.lastDeliveredAt,
      title: 'Last frame delivered',
      detail: c.messagesDelivered != null ? `${c.messagesDelivered} messages delivered so far.` : 'Frame delivered.',
      tone: 'success',
    });
  }
  if (c.lastError) {
    steps.push({ at: null, title: 'Error recorded', detail: c.lastError, tone: 'danger' });
  }

  return {
    connectedAt,
    connectedAtDerived: connectedAt != null,
    lastTransitionAt: c.lastTransitionAt ?? null,
    lastDeliveredAt: c.lastDeliveredAt ?? null,
    lastActivityAt: c.lastActivityAt ?? null,
    lastReason: c.lastReason ?? null,
    steps,
  };
}

function lifecycleTone(s: string | null | undefined): TimelineStep['tone'] {
  switch ((s ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'success';
    case 'CREATED':
    case 'CONNECTING':
      return 'info';
    case 'DISCONNECTING':
      return 'warning';
    case 'TERMINATED':
      return 'danger';
    default:
      return 'muted';
  }
}

// ---------------------------------------------------------------------------
// WHY — what did they ask for, and what are they getting?
// ---------------------------------------------------------------------------

export interface ConnectionPurpose {
  /** One-line summary assembled from real fields. */
  summary: string;
  /** Channel name → purpose blurb, for the subscribed list. */
  channels: { name: string; purpose: string | null }[];
  /** Field availability roll-up (spec §10). */
  fieldRollup: { status: string; count: number; label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' }[];
  /** Which upstream engine feeds this consumer. */
  feedSource: ProperName | null;
  /** How frames reach it. */
  delivery: ProperName | null;
  /** Profiles it asked for. */
  profiles: string[];
  /** Fields it requested. */
  fields: string[];
  /** Count of instruments it is subscribed to. */
  instruments: number | null;
}

export function purposeOf(c: CmConnection): ConnectionPurpose {
  const channels = (c.channels ?? []).map((name) => ({ name, purpose: channelPurpose(name) }));

  const rollup = new Map<string, number>();
  for (const status of Object.values(c.fieldStatus ?? {})) {
    if (!status) continue;
    rollup.set(status, (rollup.get(status) ?? 0) + 1);
  }
  const fieldRollup = [...rollup.entries()]
    .map(([status, count]) => {
      const p = fieldStatusName(status);
      return {
        status,
        count,
        label: p?.label ?? status,
        tone: fieldStatusTone(status),
      };
    })
    .sort((a, b) => b.count - a.count);

  const n = c.channels?.length ?? 0;

  return {
    summary: n
      ? `Subscribed to ${n} channel${n === 1 ? '' : 's'}${c.instruments ? ` across ${c.instruments} instrument${c.instruments === 1 ? '' : 's'}` : ''}.`
      : 'No channel subscription recorded yet.',
    channels,
    fieldRollup,
    feedSource: sourceName(c.source),
    delivery: deliveryMethodName(c.deliveryMethod),
    profiles: c.profiles ?? [],
    fields: c.requestedFields ?? [],
    instruments: c.instruments ?? null,
  };
}

export function fieldStatusTone(status: string | null | undefined) {
  switch ((status ?? '').toUpperCase()) {
    case 'AVAILABLE':
      return 'success' as const;
    case 'PARTIAL':
    case 'NOT_READY':
      return 'warning' as const;
    case 'UNAVAILABLE':
    case 'SOURCE_ERROR':
      return 'danger' as const;
    default:
      return 'neutral' as const;
  }
}

// ---------------------------------------------------------------------------
// Grouping — "N terminals, 2 strategies" for the summary strip
// ---------------------------------------------------------------------------

export interface ConsumerGroup {
  key: string;
  label: string;
  blurb: string;
  count: number;
  alive: number;
}

export function groupByConsumerType(registry: CmConnection[], isAlive: (s: string) => boolean): ConsumerGroup[] {
  const groups = new Map<string, ConsumerGroup>();
  for (const c of registry) {
    const key = (c.consumerType || 'UNKNOWN').toUpperCase();
    const name = consumerTypeName(c.consumerType);
    const g = groups.get(key) ?? {
      key,
      label: name?.label ?? key,
      blurb: name?.blurb ?? 'Consumer type not declared by the backend.',
      count: 0,
      alive: 0,
    };
    g.count += 1;
    if (isAlive(c.status)) g.alive += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}