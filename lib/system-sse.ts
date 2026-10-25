'use client';

/**
 * Shared browser SSE channel for the app-level system stream
 * (``/api/system/stream``).
 *
 * REALTIME-provider (notifications, pipeline, ws_live, tick analytics) and the
 * settings cross-tab sync both want frames from the same endpoint. ONE
 * EventSource per browser session serves both — consumers register listeners
 * and the module owns connection + reconnect with coalescing. Frames are
 * delivered as the raw EventSource payload string; consumers parse what they
 * expect (the stream may carry heartbeats / comments).
 */

import { getSystemStreamUrl } from '@/lib/api';

type Listener = (rawData: string) => void;

interface SystemSseState {
  connected: boolean;
  lastMessageAt: number | null;
  reconnectCount: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

const listeners = new Set<Listener>();
let consumerCount = 0;
const state: SystemSseState = {
  connected: false,
  lastMessageAt: null,
  reconnectCount: 0,
};
const stateListeners = new Set<(s: SystemSseState) => void>();

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
    es = new EventSource(getSystemStreamUrl());
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
    const raw = event.data;
    if (typeof raw !== 'string' || raw === '') {
      // heartbeat / comment frame
      state.lastMessageAt = Date.now();
      emitState();
      return;
    }
    state.lastMessageAt = Date.now();
    emitState();
    listeners.forEach((l) => l(raw));
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

/** Subscribe to raw frames from the shared system stream. Returns unsubscriber. */
export function subscribeSystemFrames(listener: Listener): () => void {
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
export function subscribeSystemSseState(l: (s: SystemSseState) => void): () => void {
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

export function getSystemSseState(): SystemSseState {
  return { ...state };
}
