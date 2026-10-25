'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDummyState, type DummyState } from '@/lib/dummy';

/**
 * Shared Dummy-state store (stale-while-revalidate).
 *
 * Why this is module-level rather than per-component:
 *   - every Dummy page polls the same `/api/dummy/state` endpoint. Several
 *     panels mounted during a route transition used to start independent
 *     intervals, so the backend received N identical requests for one screen;
 *   - a page mount used to start with `state=null`, throwing away the data the
 *     previous page had already loaded and showing a spinner on every
 *     navigation. The last snapshot is now rendered immediately and revalidated
 *     in the background (the `stale` flag is honest about its age);
 *   - one scheduler is shared by all subscribers, pauses while the tab is
 *     hidden, never overlaps requests, and backs off on failures instead of
 *     hammering a slow backend.
 *
 * Trading safety: this only caches server responses verbatim. It never
 * fabricates or optimistically mutates account/order/position data, and an
 * order path calls `refresh()` (which bypasses the poll cadence) after the
 * write completes.
 */

type Snapshot = {
  data: DummyState | null;
  error: string | null;
  updatedAt: number | null;
  loading: boolean;
};

const BASE_POLL_MS = 3000;
const MAX_BACKOFF_MS = 30000;
const STALE_AFTER_MS = 10000;

let snapshot: Snapshot = { data: null, error: null, updatedAt: null, loading: true };
const listeners = new Set<(next: Snapshot) => void>();

let subscribers = 0;
let basePollMs = BASE_POLL_MS;
const activeIntervals = new Map<number, number>();
let nextSubscriberId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let stopped = true;
let failureStreak = 0;

function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // a broken subscriber must never stop the shared poller
    }
  }
}

function clearTimer() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function nextDelay(success: boolean): number {
  if (!success) {
    const backoff = Math.min(BASE_POLL_MS * 2 ** failureStreak, MAX_BACKOFF_MS);
    failureStreak = Math.min(failureStreak + 1, 6);
    return Math.max(backoff, basePollMs);
  }
  failureStreak = 0;
  return Math.max(basePollMs, 1500);
}

function schedule(delay: number) {
  clearTimer();
  if (stopped) return;
  if (typeof document !== 'undefined' && document.hidden) return; // resume on visibilitychange
  timer = setTimeout(() => void run(), delay);
}

async function run(force = false): Promise<void> {
  if (stopped) return;
  if (inFlight) {
    // `refresh()` racing a scheduled poll: share the same request instead of
    // issuing a second one (dedupFetch also protects cross-store callers).
    await inFlight;
    return;
  }
  if (!force && typeof document !== 'undefined' && document.hidden) return;

  inFlight = (async () => {
    try {
      const next = await getDummyState();
      publish({
        data: next,
        error: null,
        updatedAt: Date.now(),
        loading: false,
      });
    } catch (err) {
      // Keep the last good snapshot on screen; surface the honest error.
      publish({
        error: err instanceof Error ? err.message : 'state refresh failed',
        loading: false,
      });
    } finally {
      inFlight = null;
      schedule(nextDelay(snapshot.error == null));
    }
  })();
  await inFlight;
}

function startScheduler() {
  if (!stopped) return;
  stopped = false;
  const age = snapshot.updatedAt == null ? Number.POSITIVE_INFINITY : Date.now() - snapshot.updatedAt;
  // Fresh enough: wait out the remainder instead of refetching on mount.
  const wait = age >= basePollMs ? 0 : Math.max(basePollMs - age, 0);
  schedule(wait);
}

function stopScheduler() {
  stopped = true;
  clearTimer();
}

function maybeStop() {
  if (subscribers <= 0) stopScheduler();
}

/** Force a read now (bypasses the poll cadence; never bypasses the backend). */
export async function refreshDummyStateNow(): Promise<void> {
  await run(true);
}

export function useDummyState(pollMs = BASE_POLL_MS, enabled = true) {
  const [local, setLocal] = useState<Snapshot>(snapshot);

  useEffect(() => {
    if (!enabled) return;
    const requested = Math.max(pollMs, 1500);
    const subscriberId = nextSubscriberId++;
    activeIntervals.set(subscriberId, requested);
    basePollMs = Math.min(...activeIntervals.values());
    subscribers += 1;

    const listener = (next: Snapshot) => setLocal(next);
    listeners.add(listener);
    setLocal(snapshot);
    startScheduler();

    const onVisibility = () => {
      if (document.hidden) {
        clearTimer();
        return;
      }
      // Tab is visible again: revalidate immediately if the data is stale,
      // otherwise resume the normal cadence.
      const age = snapshot.updatedAt == null ? Number.POSITIVE_INFINITY : Date.now() - snapshot.updatedAt;
      if (age >= basePollMs) void run(true);
      else schedule(Math.max(basePollMs - age, 0));
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      listeners.delete(listener);
      activeIntervals.delete(subscriberId);
      subscribers -= 1;
      basePollMs = activeIntervals.size
        ? Math.min(...activeIntervals.values())
        : BASE_POLL_MS;
      maybeStop();
    };
  }, [pollMs, enabled]);

  const refresh = useCallback(() => run(true), []);

  const stale =
    snapshot.updatedAt == null ||
    Date.now() - snapshot.updatedAt > STALE_AFTER_MS;

  return {
    state: local.data,
    error: local.error,
    loading: local.loading && local.data == null,
    stale,
    updatedAt: local.updatedAt,
    refresh,
  };
}
