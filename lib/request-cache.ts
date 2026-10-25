/**
 * Client-side request cache: ONE in-flight per resource key + fresh-cache
 * reuse + stale-while-revalidate.
 *
 * Every dashboard/subscriptions/stock-stats fetch goes through here so that
 * overlapping pollers, StrictMode double-effects and visibility handlers share
 * a single network call per key instead of stacking duplicate requests.
 *
 * - fresh (age < `maxAgeMs`)            -> served from cache, no fetch.
 * - stale-revalidating (age < `swrMs`)  -> served from cache (still real,
 *   recently-loaded data) and refreshed in the background (deduped).
 * - too stale / never loaded            -> the shared single-flight fetch runs
 *   and, on success, refreshes the cache. On failure nothing is cached, so
 *   genuine errors still surface to the caller.
 */
export type CacheLoad<T> = () => Promise<{
  status: number;
  data: T | null;
  aborted?: boolean;
}>;

export type CachedResult<T> = {
  data: T | null;
  status: number;
  fromCache: boolean;
  stale: boolean;
  aborted: boolean;
};

export type CacheOptions = {
  maxAgeMs?: number;
  swrMs?: number;
  /**
   * Skip the freshness/stale-while-revalidate checks entirely and always
   * re-run the loader. Used by an explicit user action whose result must be
   * visible immediately (e.g. "Manual Login" — waiting out the cache window
   * makes a successful action look like it did nothing).
   */
  force?: boolean;
};

interface Entry<T> {
  data: T;
  status: number;
  updatedAt: number;
}

const entries = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<boolean>>();

// Reports whether the shared single-flight load was aborted. Because the task
// is shared across callers with DIFFERENT controllers, an abort must propagate
// to every waiter (not just the controller owner) — otherwise caller B would
// treat caller A's abort as its own network failure.
function refreshInto<T>(key: string, loader: CacheLoad<T>): Promise<boolean> {
  let task = inflight.get(key);
  if (task) return task;
  task = Promise.resolve()
    .then(() => loader())
    .then(({ status, data, aborted }) => {
      // Cache successful payloads AND genuine HTTP failures (status >= 400) so
      // the real status (e.g. 502) surfaces to callers instead of collapsing to
      // 0. True network-level failures (status 0), aborts stay uncached.
      if (data != null || status >= 400) {
        entries.set(key, { data, status, updatedAt: Date.now() });
      }
      return Boolean(aborted);
    });
  inflight.set(key, task);
  void task.finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  return task;
}

export async function getCached<T>(
  key: string,
  loader: CacheLoad<T>,
  opts: CacheOptions = {},
): Promise<CachedResult<T>> {
  const maxAgeMs = opts.maxAgeMs ?? 10_000;
  const swrMs = opts.swrMs ?? 60_000;
  const now = Date.now();

  const hit = entries.get(key) as Entry<T> | undefined;
  // `force` still honours an in-flight single-flight load rather than firing a
  // second identical request — it only skips the AGE checks below.
  if (hit && !opts.force) {
    // Genuine HTTP failures are served immediately with their real status so
    // error consumers never see a fabricated 0, but they are always re-fetched
    // in the background — an error entry must not hold off recovery until the
    // full maxAge window elapses.
    if (hit.status >= 400) {
      void refreshInto(key, loader);
      return { data: hit.data, status: hit.status, fromCache: true, stale: true, aborted: false };
    }
    const age = now - hit.updatedAt;
    if (age < maxAgeMs) {
      return { data: hit.data, status: hit.status, fromCache: true, stale: false, aborted: false };
    }
    if (age < swrMs) {
      void refreshInto(key, loader);
      return { data: hit.data, status: hit.status, fromCache: true, stale: true, aborted: false };
    }
  }

  const aborted = await refreshInto(key, loader);
  if (aborted) {
    // An abort is not a cache miss and not a failure — caller B must not turn
    // caller A's aborted shared fetch into its own error.
    return { data: null, status: 0, fromCache: false, stale: false, aborted: true };
  }
  const fresh = entries.get(key) as Entry<T> | undefined;
  if (fresh) {
    return { data: fresh.data, status: fresh.status, fromCache: false, stale: false, aborted: false };
  }
  return { data: null, status: 0, fromCache: false, stale: false, aborted: false };
}

/** Drop cached state (e.g. after a forced full refresh or logout). */
export function clearCache(key?: string) {
  if (key) entries.delete(key);
  else entries.clear();
}