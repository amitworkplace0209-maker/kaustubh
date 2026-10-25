/**
 * Realtime snapshot store — the frontend's WebSocket-driven data layer.
 *
 * The platform used to poll REST from every page (2-10 s intervals, one
 * timer per component). This store turns that into ONE persistent socket:
 *
 *   * `subscribeChannel('orders')` tells the backend "send me the `orders`
 *     document". The backend answers with an authoritative snapshot frame
 *     immediately and then re-pushes it whenever it actually changes.
 *   * `getChannelDocument('orders')` returns the latest document — the UI
 *     renders it, no fetch, no timer.
 *
 * Design rules
 *   - ONE socket for the whole app (`realtimeClient`), one subscription per
 *     channel no matter how many components ask for it (ref-counted).
 *   - Snapshots are the source of truth; delta frames (`order.update`,
 *     `notification.new`, `system.status`, …) are merged into the document
 *     when the shape is known, and otherwise bump an `epoch` so a consumer can
 *     react without a re-render storm.
 *   - Nothing here ever fabricates data: an absent document stays `null`.
 *
 * A REST fallback belongs to the CONSUMER (`useRealtimeChannel`), which polls
 * only while the socket has not delivered a document — so a dead backend
 * degrades to the old behaviour instead of an empty screen.
 */
import { realtimeClient } from './realtime-ws.ts';
import type { RealtimeEnvelope, RealtimeLiveState } from './realtime-ws.ts';

export type RealtimeDocument = Record<string, any>;

export type ChannelState = {
  /** The latest authoritative document for the channel (null until it arrives). */
  document: RealtimeDocument | null;
  /** Epoch ms of the last document/delta for this channel. */
  updatedAt: number;
  /** True once a snapshot frame has been received for this channel. */
  received: boolean;
  /** Bumped on every delta event for this channel. */
  epoch: number;
};

const EMPTY_STATE: ChannelState = {
  document: null,
  updatedAt: 0,
  received: false,
  epoch: 0,
};

type ChannelEntry = {
  refs: number;
  state: ChannelState;
  listeners: Set<() => void>;
};

const channels = new Map<string, ChannelEntry>();
const globalListeners = new Set<() => void>();
let installed = false;
let connectionState: RealtimeLiveState = realtimeClient.getState();

function entryFor(channel: string): ChannelEntry {
  let entry = channels.get(channel);
  if (!entry) {
    entry = { refs: 0, state: { ...EMPTY_STATE }, listeners: new Set() };
    channels.set(channel, entry);
  }
  return entry;
}

function notify(entry: ChannelEntry) {
  for (const cb of entry.listeners) {
    try {
      cb();
    } catch {
      // listener errors must never break the socket
    }
  }
  for (const cb of globalListeners) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}

function setDocument(channel: string, document: RealtimeDocument) {
  const entry = entryFor(channel);
  entry.state = {
    document,
    updatedAt: Date.now(),
    received: true,
    epoch: entry.state.epoch + 1,
  };
  notify(entry);
}

function bumpEpoch(channel: string) {
  const entry = entryFor(channel);
  entry.state = { ...entry.state, updatedAt: Date.now(), epoch: entry.state.epoch + 1 };
  notify(entry);
}

/** Merge a `state_changed` delta into the system document. */
function mergeSystemDelta(frame: RealtimeEnvelope) {
  const entry = entryFor('system');
  const document = entry.state.document;
  const data = (frame.data ?? {}) as Record<string, any>;
  const inner = (data.payload ?? data) as Record<string, any>;
  if (!document || !inner) return;

  if (inner.type === 'state_changed' && inner.entity) {
    const changes = (inner.changes ?? {}) as Record<string, any>;
    const nextState = { ...(document.state ?? {}) };
    nextState[inner.entity] = { ...(nextState[inner.entity] ?? {}), ...changes };
    setDocument('system', { ...document, state: nextState });
    return;
  }
  if (inner.type === 'service_changed' && inner.service) {
    const changes = (inner.changes ?? {}) as Record<string, any>;
    const nextState = { ...(document.state ?? {}) };
    const services = { ...(nextState.services ?? {}) };
    services[inner.service] = {
      ...(services[inner.service] ?? {}),
      ...changes,
      updatedAt: inner.timestamp,
    };
    nextState.services = services;
    setDocument('system', { ...document, state: nextState });
    return;
  }
  bumpEpoch('system');
}

/** Merge a notification delta into the notifications document. */
function mergeNotificationDelta(frame: RealtimeEnvelope) {
  const entry = entryFor('notifications');
  const document = entry.state.document;
  const data = (frame.data ?? {}) as Record<string, any>;
  const inner = (data.payload ?? data) as Record<string, any>;
  if (!document || !inner) {
    bumpEpoch('notifications');
    return;
  }

  const notifications = Array.isArray(document.notifications) ? [...document.notifications] : [];
  const id = String(inner.notification_id ?? inner.notification?._id ?? '');
  const unread = typeof inner.unreadCount === 'number' ? inner.unreadCount : document.unreadCount;

  if (inner.type === 'notification_created' && inner.notification) {
    const row = inner.notification as Record<string, any>;
    const rowId = String(row._id ?? id);
    if (rowId && !notifications.some((n) => String(n?._id ?? '') === rowId)) {
      notifications.unshift(row);
    }
  } else if (inner.type === 'notification_updated' && id) {
    const changes = (inner.changes ?? {}) as Record<string, any>;
    notifications.forEach((n) => {
      if (String(n?._id ?? '') !== id) return;
      if (typeof inner.read === 'boolean') {
        n.read = inner.read;
        n.status = inner.read ? 'read' : 'unread';
      }
      Object.assign(n, changes);
    });
  } else if (inner.type === 'notification_deleted' && id) {
    for (let i = notifications.length - 1; i >= 0; i -= 1) {
      if (String(notifications[i]?._id ?? '') === id) notifications.splice(i, 1);
    }
  }

  setDocument('notifications', {
    ...document,
    notifications: notifications.slice(0, 200),
    unreadCount: unread,
  });
}

/** Merge a `market_watch.*` state frame into the market-watch document. */
function mergeMarketWatchDelta(frame: RealtimeEnvelope) {
  const entry = entryFor('market_watch');
  const document = entry.state.document;
  const data = (frame.data ?? {}) as Record<string, any>;
  const inner = (data.payload ?? data) as Record<string, any>;
  if (!inner || typeof inner !== 'object') {
    bumpEpoch('market_watch');
    return;
  }
  const base = document ?? {};
  const type = String(frame.type ?? '');

  if (type === 'market_watch.ranking') {
    setDocument('market_watch', { ...base, ranking: inner });
    return;
  }
  if (type === 'market_watch.pins') {
    const pins = (inner.pins ?? inner) as Record<string, any>;
    setDocument('market_watch', {
      ...base,
      pins: {
        gainers: pins?.gainers ?? [],
        losers: pins?.losers ?? [],
      },
    });
    return;
  }
  if (type === 'market_watch.status') {
    setDocument('market_watch', { ...base, status: inner });
    return;
  }
  if (type === 'market_watch.ui') {
    const payload = (inner.payload ?? inner) as RealtimeDocument;
    if (payload && typeof payload === 'object') {
      setDocument('market_watch', { ...base, ui: payload });
      return;
    }
  }
  bumpEpoch('market_watch');
}

/**
 * Route the `engine.status` push into the `engines` channel document.
 *
 * The backend pushes the WHOLE control plane in one frame (every engine +
 * the registry summary + the broker registry), so the Service Control Center
 * renders from ONE socket subscription instead of four REST polls.
 */
function mergeEngineStatus(frame: RealtimeEnvelope) {
  const data = (frame.data ?? {}) as Record<string, any>;
  const inner = (data.payload ?? data) as Record<string, any>;
  const engines = inner?.engines;
  if (!engines || typeof engines !== 'object') {
    bumpEpoch('engines');
    return;
  }
  setDocument('engines', {
    engines,
    count: inner.count ?? Object.keys(engines).length,
    summary: inner.summary ?? null,
    brokers: inner.brokers ?? null,
    generatedAt: inner.generatedAt ?? null,
  });
}

function handleFrame(frame: RealtimeEnvelope) {
  const type = String(frame.type ?? '');
  const channel = String(frame.channel ?? '');

  // Authoritative document frames (system.snapshot / orders.snapshot / …).
  if (type.endsWith('.snapshot')) {
    const data = (frame.data ?? {}) as Record<string, any>;
    let payload = (data.payload ?? data) as RealtimeDocument;
    // The Data Center push nests the aggregation one level deeper
    // (`{type, generatedAt, data: <snapshot>}`) — unwrap it so the document
    // is the snapshot itself, exactly like the REST endpoint's payload.
    if (payload && typeof payload === 'object' && type === 'data_center.snapshot') {
      const inner = (payload as Record<string, any>).data;
      if (inner && typeof inner === 'object') payload = inner as RealtimeDocument;
    }
    if (payload && typeof payload === 'object') {
      const target = channel || type.slice(0, -'.snapshot'.length);
      setDocument(target, payload);
    }
    return;
  }

  switch (type) {
    case 'notification.new':
    case 'notification.updated':
    case 'notification.deleted':
    case 'notification.count_changed':
      mergeNotificationDelta(frame);
      return;
    case 'system.status':
      mergeSystemDelta(frame);
      return;
    case 'engine.status':
      mergeEngineStatus(frame);
      return;
    default:
      break;
  }

  if (type.startsWith('market_watch.')) {
    mergeMarketWatchDelta(frame);
    return;
  }

  // Any other delta on a known channel bumps its epoch so a consumer can
  // react (the authoritative document follows in the next snapshot push).
  if (channel) bumpEpoch(channel);
}

function handleConnectionState(next: RealtimeLiveState) {
  connectionState = next;
  for (const cb of globalListeners) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
  if (next === 'CONNECTED') {
    // The socket dropped its server-side subscription set on close — restore
    // every channel the UI still cares about.
    const wanted = Array.from(channels.entries())
      .filter(([, entry]) => entry.refs > 0)
      .map(([channel]) => channel);
    if (wanted.length) {
      void realtimeClient
        .subscribe(wanted.map((channel) => ({ channel })))
        .catch(() => {});
    }
  }
}

function install() {
  if (installed) return;
  installed = true;
  realtimeClient.onFrame(handleFrame);
  realtimeClient.onStateChange(handleConnectionState);
}

// --------------------------------------------------------------------------- //
// Public API
// --------------------------------------------------------------------------- //

/** Current socket state ('DISCONNECTED' until the socket is opened). */
export function getRealtimeConnectionState(): RealtimeLiveState {
  return connectionState;
}

/** The latest document for a channel (null until the first snapshot arrives). */
export function getChannelDocument(channel: string): RealtimeDocument | null {
  return channels.get(channel)?.state.document ?? null;
}

/** The full channel state (document + updatedAt + received + epoch). */
export function getChannelState(channel: string): ChannelState {
  return channels.get(channel)?.state ?? EMPTY_STATE;
}

/** True when the channel has delivered at least one snapshot frame. */
export function isChannelLive(channel: string): boolean {
  return channels.get(channel)?.state.received === true;
}

/**
 * Subscribe to a channel. Ref-counted: the WS subscription is created when
 * the first consumer arrives and dropped when the last one leaves.
 */
export function subscribeChannel(channel: string): () => void {
  install();
  const entry = entryFor(channel);
  entry.refs += 1;

  if (entry.refs === 1) {
    void realtimeClient.subscribe([{ channel }]).catch(() => {});
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.refs = 0;
      void realtimeClient.unsubscribe([{ channel }]).catch(() => {});
    }
  };
}

/** Listen for state changes of one channel. Returns an unsubscribe function. */
export function subscribeChannelState(channel: string, cb: () => void): () => void {
  const entry = entryFor(channel);
  entry.listeners.add(cb);
  return () => {
    entry.listeners.delete(cb);
  };
}

/** Listen for ANY channel change (used by app-level indicators). */
export function subscribeRealtime(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => {
    globalListeners.delete(cb);
  };
}

/**
 * Force an immediate snapshot request for a channel.
 *
 * The backend pushes the document on subscribe and on every change; this is
 * the explicit "refresh now" path (used after a mutation).
 */
export async function refreshChannel(channel: string): Promise<void> {
  install();
  try {
    // `force` bypasses the client's "already subscribed" short-circuit so the
    // backend really re-sends the authoritative document.
    await realtimeClient.subscribe([{ channel }], undefined, { force: true });
  } catch {
    // The backend ignores a repeated subscribe for an already-subscribed
    // channel, so a refresh is best-effort — the periodic snapshot push
    // still delivers the current document.
  }
}
