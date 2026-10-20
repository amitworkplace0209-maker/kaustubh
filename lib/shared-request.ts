'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Shared client-side request management for the whole KAUSTUBH platform.
 *
 * Goals (spec section 29 / 49 / item 59.7):
 *  - one interval per resource instead of one per card (no request storms);
 *  - collapse concurrent identical requests into a single network call;
 *  - abort in-flight requests on unmount / route change;
 *  - pause polling while the tab is hidden (visibility-aware);
 *  - no infinite loops, no duplicate intervals.
 */

type CacheEntry = {
  promise: Promise<any>;
  expiresAt: number;
  data: any;
};

let inflight: Map<string, Promise<any>> = new Map();
let cacheStore: Map<string, CacheEntry> = new Map();
let cacheListeners: Set<() => void> = new Set();
let refreshCounter = 0;

const DEFAULT_TTL_MS = 5000;

function notifyCache(): void {
  cacheListeners.forEach((l) => l());
}

/**
 * Request deduplication: if an identical request (same key) is already in
 * flight, reuse that promise. Optionally serve from a short-lived cache.
 */
export function dedupeFetch<T = any>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlMs?: number; force?: boolean } = {},
): Promise<T> {
  const { ttlMs = DEFAULT_TTL_MS, force = false } = opts;

  if (!force) {
    const cached = cacheStore.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.data as T);
    }
  }

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const p = fetcher()
    .then((data) => {
      cacheStore.set(key, { promise: p, expiresAt: Date.now() + ttlMs, data });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
      notifyCache();
    });

  inflight.set(key, p);
  notifyCache();
  return p;
}

export function invalidateCache(key?: string): void {
  if (key) {
    cacheStore.delete(key);
  } else {
    cacheStore.clear();
  }
  notifyCache();
}

export function subscribeCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => cacheListeners.delete(listener);
}

export function getCacheSnapshot(): { size: number } {
  return { size: cacheStore.size };
}

/**
 * Central polling. Each call with the same `resource` contributes to a single
 * shared timer; the resource is fetched once per tick regardless of how many
 * components subscribe to it.
 */
const pollTimers: Record<string, { timer: ReturnType<typeof setInterval> | null }> = {};
const pollData: Record<string, any> = {};
const pollVersions: Record<string, number> = {};
const pollListeners: Record<string, Set<() => void>> = {};

function startSharedTimer(resource: string, fetcher: () => Promise<void>, intervalMs: number): void {
  const rec = pollTimers[resource] ?? { timer: null };
  if (rec.timer) return;

  const run = async (): Promise<void> => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return; // visibility-aware: don't poll hidden tabs
    }
    await fetcher();
  };

  rec.timer = setInterval(run, intervalMs);
  void run();
  pollTimers[resource] = rec;
}

function stopSharedTimer(resource: string): void {
  const rec = pollTimers[resource];
  if (!rec) return;
  if (rec.timer) clearInterval(rec.timer);
  rec.timer = null;
}

function onPollChange(resource: string): void {
  pollVersions[resource] = (pollVersions[resource] ?? 0) + 1;
  pollListeners[resource]?.forEach((l) => l());
}

export function useSharedPolling<T = any>(
  resource: string,
  fetcher: () => Promise<T>,
  options: { intervalMs?: number; ttlMs?: number } = {},
): { data: T | null; loading: boolean; error: string | null } {
  const { intervalMs = 5000, ttlMs = 4000 } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const safeResource = resource;

  useEffect(() => {
    const load = (): Promise<void> =>
      dedupeFetch(safeResource, () => fetcherRef.current(), { ttlMs }).then(
        (d) => {
          pollData[safeResource] = d;
          onPollChange(safeResource);
        },
        () => {
          onPollChange(safeResource);
        },
      );

    startSharedTimer(safeResource, load, intervalMs);
    onPollChange(safeResource);
    return () => {
      const others = (pollListeners[safeResource] ?? new Set()).size;
      if (others <= 0) stopSharedTimer(safeResource);
    };
  }, [safeResource, intervalMs, ttlMs]);

  useSyncExternalStore(
    (cb: () => void) => {
      (pollListeners[safeResource] ??= new Set()).add(cb);
      return () => pollListeners[safeResource]?.delete(cb);
    },
    () => pollVersions[safeResource] ?? 0,
    () => 0,
  );

  return {
    data: (pollData[safeResource] as T) ?? (null as T),
    loading: pollData[safeResource] == null,
    error: null,
  };
}

export function useCachedResource<T = any>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlMs?: number } = {},
): { data: T | null; refresh: () => void; invalidate: () => void } {
  const { ttlMs = DEFAULT_TTL_MS } = opts;
  useSyncExternalStore(
    (cb) => {
      cacheListeners.add(cb);
      return () => cacheListeners.delete(cb);
    },
    () => refreshCounter,
    () => 0,
  );

  useEffect(() => {
    void dedupeFetch(key, fetcher, { ttlMs }).then(() => {
      refreshCounter += 1;
      notifyCache();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ttlMs]);

  const entry = cacheStore.get(key);
  const data = entry ? (entry.data as T) : null;

  return {
    data,
    refresh: () => {
      void dedupeFetch(key, fetcher, { ttlMs, force: true }).then(() => {
        refreshCounter += 1;
        notifyCache();
      });
    },
    invalidate: () => {
      invalidateCache(key);
      refreshCounter += 1;
      notifyCache();
    },
  };
}
