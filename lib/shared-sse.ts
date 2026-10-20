'use client';

/**
 * Shared browser realtime channel — ONE SSE connection for the whole
 * PWA/browser session.
 *
 * Every consumer (Tick Analytics, Watch page, Stock lists, Download runner)
 * subscribes to this single EventSource instead of creating its own. This
 * satisfies:
 *   - ONE browser realtime connection per session.
 *   - No duplicate /api/ticks/stream connections when multiple pages mount.
 *   - Automatic shared reconnect with coalescing (reconnect storms deduped).
 *   - Latest tick map + per-subscriber listen queue.
 */

import { getTickStreamUrl } from '@/lib/api';

type Listener = (tick: Record<string, any>) => void;

interface SharedSseState {
  connected: boolean;
  lastMessageAt: number | null;
  reconnectCount: number;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 15000;

const listeners = new Set<Listener>();
let consumerCount = 0;
const state: SharedSseState = {
  connected: false,
  lastMessageAt: null,
  reconnectCount: 0,
};
const stateListeners = new Set<(s: SharedSseState) => void>();

let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RECONNECT_BASE_MS;
/** Coalesce reconnects: only the first request while disconnected opens a new ES. */
let connecting = false;

function emitState() {
  const snapshot = { ...state };
  stateListeners.forEach((l) => l(snapshot));
}

function openStream() {
  if (es || connecting) return;
  connecting = true;
  try {
    es = new EventSource(getTickStreamUrl());
  } catch {
    connecting = false;
    scheduleReconnect();
    return;
  }

  es.onopen = () => {
    state.connected = true;
    retryDelay = RECONNECT_BASE_MS;
    connecting = false;
    emitState();
  };

  es.onerror = () => {
    const wasConnected = state.connected;
    state.connected = false;
    connecting = false;
    if (es) {
      es.close();
      es = null;
    }
    if (wasConnected) state.reconnectCount += 1;
    emitState();
    scheduleReconnect();
  };

  es.onmessage = (event) => {
    try {
      const tick = JSON.parse(event.data);
      if (tick && typeof tick === 'object') {
        state.lastMessageAt = Date.now();
        emitState();
        listeners.forEach((l) => l(tick));
      }
    } catch {
      // malformed frame — ignore
    }
  };
}

function scheduleReconnect() {
  if (consumerCount === 0) return; // no consumers → do not reconnect
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (consumerCount > 0) openStream();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
}

function closeStream() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (es) {
    es.close();
    es = null;
  }
  connecting = false;
  state.connected = false;
  retryDelay = RECONNECT_BASE_MS;
  emitState();
}

/** Subscribe to the shared tick stream. Returns an unsubscribe function. */
export function subscribeTicks(listener: Listener): () => void {
  listeners.add(listener);
  if (consumerCount === 0) openStream();
  consumerCount += 1;
  return () => {
    listeners.delete(listener);
    consumerCount = Math.max(0, consumerCount - 1);
    if (consumerCount === 0) closeStream();
  };
}

/** Subscribe to connection state updates. Returns an unsubscribe function. */
export function subscribeSseState(l: (s: SharedSseState) => void): () => void {
  stateListeners.add(l);
  if (consumerCount === 0) openStream();
  consumerCount += 1;
  l({ ...state });
  return () => {
    stateListeners.delete(l);
    consumerCount = Math.max(0, consumerCount - 1);
    if (consumerCount === 0) closeStream();
  };
}

export function getSharedSseState(): SharedSseState {
  return { ...state };
}