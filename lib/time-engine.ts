'use client';

// Single shared client-side TIME engine.
//
// Responsibility is deliberately narrow:
//   1. Anchor the browser clock to the backend server clock once
//      (GET /api/system/time â†’ offset_ms). The SERVER is authoritative for
//      every financial/session timestamp; the browser clock is never trusted
//      for business state.
//   2. Emit one 1-second tick (module-level, shared by every consumer).
//   3. Compute DERIVED display values only:
//        remaining = target_timestamp âˆ’ server_now
//        age       = server_now âˆ’ updated_at
//   4. It never fabricates business events â€” no 'now = last update'.
//
// The absolute timestamps come from the backend; this module only renders them.

import { useSyncExternalStore } from 'react';
import { API_BASE as browserApiBase } from '@/lib/api-base';

// Same-origin in the browser: 127.0.0.1 is the DEVICE on a phone, so an
// absolute backend URL can never work there. See lib/api-base.ts.
const API_BASE = browserApiBase;

let offsetMs: number | null = null;
let syncedAt = 0;
let syncPromise: Promise<number | null> | null = null;

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Sync the server clock offset (best effort, cached 5 min, single-flight). */
export async function syncServerTime(force = false): Promise<number | null> {
  if (typeof window === 'undefined') return null;
  const now = Date.now();
  if (!force && offsetMs != null && now - syncedAt < 5 * 60_000) return offsetMs;
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/system/time`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      const server = toMs(data.server_time_utc ?? data.generated_at);
      if (server == null) return null;
      offsetMs = server - Date.now();
      syncedAt = Date.now();
      return offsetMs;
    } catch {
      return null;
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

/** Best-effort authoritative "now" in epoch ms (server-anchored). */
export function serverNowMs(): number {
  return Date.now() + (offsetMs ?? 0);
}

// ---------------------------------------------------------------------------
// One shared 1s tick (only while at least one subscriber exists).
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let timerId: number | null = null;
// Cached snapshot version. Bumped ONLY inside the interval tick, so
// getSnapshot returns a bit-identical value between ticks â€” this is what makes
// useSyncExternalStore stable (a snapshot that changes on every call, e.g.
// Date.now(), triggers an infinite render loop).
let tickVersion = 0;

function bumpTick() {
  tickVersion++;
  listeners.forEach((l) => l());
}

function startTick() {
  if (timerId != null || typeof window === 'undefined') return;
  timerId = window.setInterval(bumpTick, 1000);
}

function subscribeTick(l: () => void): () => void {
  listeners.add(l);
  startTick();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0 && timerId != null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  };
}

function getServerNowSnapshot(): number {
  return tickVersion;
}

/**
 * React to the shared server-anchored clock. Re-renders once per second.
 * Used ONLY for presentational math (countdowns / relative ages), never to
 * generate business state.
 */
export function useServerNow(): number {
  useSyncExternalStore(subscribeTick, getServerNowSnapshot, () => 0);
  return serverNowMs();
}

export type CountdownParts = { h: number; m: number; s: number };

/** remaining ms â†’ {h, m, s} (floored at zero, never negative). */
export function countdownParts(ms: number): CountdownParts {
  if (!Number.isFinite(ms) || ms <= 0) return { h: 0, m: 0, s: 0 };
  const total = Math.floor(ms / 1000);
  return {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

/** "18h 42m" / "09m 15s" / "0s" â€” signed-free, honest remaining time. */
export function formatCountdown(parts: CountdownParts, opts?: { padMinutes?: boolean }): string {
  const { h, m, s } = parts;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) {
    const mm = opts?.padMinutes ? String(m).padStart(2, '0') : String(m);
    return `${mm}m ${String(s).padStart(2, '0')}s`;
  }
  return `${s}s`;
}

/** ISO/epoch â†’ age in ms relative to the given authoritative now. */
export function ageMs(iso: string | number | null | undefined, serverNow: number): number | null {
  const t = toMs(iso);
  if (t == null) return null;
  return serverNow - t;
}

/** "just now" Â· "3s ago" Â· "2m ago" Â· "1h ago" â€” from a real backend timestamp. */
export function ageLabel(iso: string | number | null | undefined, serverNow: number): string | null {
  const ms = ageMs(iso, serverNow);
  if (ms == null) return null;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Data-freshness classification for a domain block (LIVE / STALE / UNAVAILABLE). */
export type Freshness = 'LIVE' | 'STALE' | 'UNKNOWN';

export function freshnessOf(
  iso: string | number | null | undefined,
  serverNow: number,
  staleAfterMs = 30_000,
): Freshness {
  const ms = ageMs(iso, serverNow);
  if (ms == null) return 'UNKNOWN';
  return ms <= staleAfterMs ? 'LIVE' : 'STALE';
}

/** Server-time-aware countdown hook for a target ISO/epoch timestamp. */
export function useCountdown(target: string | number | null | undefined): {
  ms: number | null;
  parts: CountdownParts | null;
  text: string | null;
} {
  const now = useServerNow();
  if (target == null) return { ms: null, parts: null, text: null };
  const t = toMs(target);
  if (t == null) return { ms: null, parts: null, text: null };
  const ms = t - now;
  const parts = countdownParts(ms);
  return { ms, parts, text: formatCountdown(parts) };
}