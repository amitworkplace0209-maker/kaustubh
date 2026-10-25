'use client';

/**
 * Shared browser SSE channel for scheduler / download lifecycle events
 * (backed by ``/api/schedule-events/stream``).
 *
 * ONE schedule-events EventSource per browser session — pages (Scheduler
 * Overview, Runs) subscribe and refetch on real events instead of opening
 * their own connections or installing duplicate polling. Frames are opaque
 * here: consumers decide what matters (a scheduler event means the Runs
 * ledger changed). Heartbeats keep the socket alive and idle consumers
 * connected; connection state is shared via subscribers.
 */

import { getScheduleEventsUrl } from '@/lib/api';

type Listener = (frame: Record<string, any>) => void;

interface ScheduleSseState {
  connected: boolean;
  lastMessageAt: number | null;
  reconnectCount: number;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 15000;

const listeners = new Set<Listener>();
let consumerCount = 0;
const state: ScheduleSseState = {
  connected: false,
  lastMessageAt: null,
  reconnectCount: 0,
};
const stateListeners = new Set<(s: ScheduleSseState) => void>();

let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RECONNECT_BASE_MS;
let connecting = false;

function emitState() {
  const snapshot = { ...state };
  stateListeners.forEach((l) => l(snapshot));
}

function openStream() {
  if (es || connecting) return;
  connecting = true;
  try {
    es = new EventSource(getScheduleEventsUrl());
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
      const frame = JSON.parse(event.data);
      if (frame && typeof frame === 'object') {
        state.lastMessageAt = Date.now();
        emitState();
        listeners.forEach((l) => l(frame));
      }
    } catch {
      // malformed frame — ignore
    }
  };
}

function scheduleReconnect() {
  if (consumerCount === 0) return;
  if (reconnectTimer) return;
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

/** Subscribe to the shared schedule-events stream. Returns unsubscriber. */
export function subscribeScheduleEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (consumerCount === 0) openStream();
  consumerCount += 1;
  return () => {
    listeners.delete(listener);
    consumerCount = Math.max(0, consumerCount - 1);
    if (consumerCount === 0) closeStream();
  };
}

/** Subscribe to connection state updates. Returns unsubscriber. */
export function subscribeScheduleState(l: (s: ScheduleSseState) => void): () => void {
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

export function getScheduleSseState(): ScheduleSseState {
  return { ...state };
}