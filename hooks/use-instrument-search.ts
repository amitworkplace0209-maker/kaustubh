'use client';

/**
 * The one instrument-search hook.
 *
 * Replaces the per-component search loops that each had their own debounce
 * value and their own (mostly missing) stale-response handling. It centralises
 * the four behaviours the Search Engine spec requires:
 *
 *   1. Debounce          — one request per pause in typing, not per keystroke.
 *   2. Stale-response    — an AbortController per in-flight request plus a
 *                          monotonic sequence, so a slow early response can
 *                          never overwrite a later one (spec §16).
 *   3. Bounded work      — minimum query length, result limit, and a hard
 *                          per-request timeout ceiling (spec §17/§18).
 *   4. Safe reuse        — a short TTL cache keyed by query+options so typing
 *                          back to a previous term does not re-hit the backend.
 *
 * It never fabricates or mutates results: everything returned comes from the
 * Search Engine response.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MAX_WAIT_MS,
  SEARCH_MIN_CHARS,
  SEARCH_SUGGESTION_LIMIT,
  shouldSearch,
  type CanonicalInstrument,
  type CanonicalSearchResponse,
  type SearchErrorCode,
} from '@/lib/instrument-search';
import { searchInstruments } from '@/lib/instrument-search-client';

/** How long a completed search stays reusable for an identical query. */
export const SEARCH_CACHE_TTL_MS = 15_000;
/** Max entries retained; oldest are evicted first. */
export const SEARCH_CACHE_MAX_ENTRIES = 50;

type CacheEntry = { at: number; response: CanonicalSearchResponse };

const responseCache = new Map<string, CacheEntry>();

function cacheKey(query: string, limit: number, withMargin: boolean): string {
  return `${query.trim().toLowerCase()}|${limit}|${withMargin ? 1 : 0}`;
}

function readCache(key: string): CanonicalSearchResponse | null {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  // Refresh recency so the hot query survives eviction.
  responseCache.delete(key);
  responseCache.set(key, hit);
  return hit.response;
}

function writeCache(key: string, response: CanonicalSearchResponse): void {
  responseCache.set(key, { at: Date.now(), response });
  while (responseCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next();
    if (oldest.done) break;
    responseCache.delete(oldest.value);
  }
}

/** Test seam: drops the module-level response cache. */
export function clearInstrumentSearchCache(): void {
  responseCache.clear();
}

export type InstrumentSearchStatus =
  | 'idle'
  | 'debouncing'
  | 'loading'
  | 'results'
  | 'empty'
  | 'error';

export interface UseInstrumentSearchResult {
  status: InstrumentSearchStatus;
  results: CanonicalInstrument[];
  error: string | null;
  errorCode: SearchErrorCode;
  /** The query the current `results` belong to — never a stale one. */
  resolvedQuery: string;
  isStale: boolean;
  clear: () => void;
  refresh: () => void;
}

export interface UseInstrumentSearchOptions {
  limit?: number;
  withMargin?: boolean;
  debounceMs?: number;
  minChars?: number;
  maxWaitMs?: number;
  enabled?: boolean;
}

function messageFor(errorCode: SearchErrorCode, fallback: string): string {
  switch (errorCode) {
    case 'SEARCH_INDEX_UNAVAILABLE':
      return 'Instrument index is unavailable. Try again shortly.';
    case 'SEARCH_INVALID_SCOPE':
      return 'That search scope is not supported.';
    case 'EMPTY_QUERY':
      return null as unknown as string;
    default:
      return fallback;
  }
}

export function useInstrumentSearch(
  query: string,
  options: UseInstrumentSearchOptions = {},
): UseInstrumentSearchResult {
  const {
    limit = SEARCH_SUGGESTION_LIMIT,
    withMargin = false,
    debounceMs = SEARCH_DEBOUNCE_MS,
    minChars = SEARCH_MIN_CHARS,
    maxWaitMs = SEARCH_MAX_WAIT_MS,
    enabled = true,
  } = options;

  const [status, setStatus] = useState<InstrumentSearchStatus>('idle');
  const [results, setResults] = useState<CanonicalInstrument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<SearchErrorCode>(null);
  const [resolvedQuery, setResolvedQuery] = useState('');
  const [isStale, setIsStale] = useState(false);
  const [nonce, setNonce] = useState(0);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const timeoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      inFlight.current?.abort();
      if (timeoutTimer.current) clearTimeout(timeoutTimer.current);
    };
  }, []);

  const clear = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    inFlight.current?.abort();
    if (timeoutTimer.current) clearTimeout(timeoutTimer.current);
    sequence.current += 1;
    setStatus('idle');
    setResults([]);
    setError(null);
    setErrorCode(null);
    setResolvedQuery('');
    setIsStale(false);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const trimmed = query.trim();

    if (!enabled || !shouldSearch(trimmed, minChars)) {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      inFlight.current?.abort();
      sequence.current += 1;
      setStatus('idle');
      setResults([]);
      setError(null);
      setErrorCode(null);
      setResolvedQuery('');
      setIsStale(false);
      return;
    }

    const key = cacheKey(trimmed, limit, withMargin);
    const cached = readCache(key);
    if (cached) {
      inFlight.current?.abort();
      sequence.current += 1;
      setResults(cached.results);
      setResolvedQuery(trimmed);
      setErrorCode(cached.errorCode);
      setError(cached.errorCode ? messageFor(cached.errorCode, '') : null);
      setStatus(cached.results.length > 0 ? 'results' : 'empty');
      setIsStale(false);
      return;
    }

    // A new query supersedes whatever is on screen until it resolves.
    setIsStale(true);

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setStatus('debouncing');

    debounceTimer.current = setTimeout(() => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      const requestSequence = ++sequence.current;

      setStatus('loading');

      timeoutTimer.current = setTimeout(() => controller.abort(), maxWaitMs);

      searchInstruments(trimmed, { limit, withMargin, signal: controller.signal })
        .then((response) => {
          if (timeoutTimer.current) clearTimeout(timeoutTimer.current);
          // Guard: unmounted, superseded by a newer query, or aborted.
          if (!mounted.current || requestSequence !== sequence.current) return;

          if (response.errorCode) {
            const message = messageFor(response.errorCode, 'Search is unavailable.');
            setErrorCode(response.errorCode);
            setError(message);
            setResults([]);
            setStatus('error');
            setIsStale(false);
            return;
          }

          writeCache(key, response);
          setError(null);
          setErrorCode(null);
          setResults(response.results);
          setResolvedQuery(trimmed);
          setStatus(response.results.length > 0 ? 'results' : 'empty');
          setIsStale(false);
        })
        .catch((err: unknown) => {
          if (timeoutTimer.current) clearTimeout(timeoutTimer.current);
          if (!mounted.current || requestSequence !== sequence.current) return;
          if (controller.signal.aborted) {
            setError('Search timed out. Try again.');
            setResults([]);
            setStatus('error');
            setIsStale(false);
            return;
          }
          setError(err instanceof Error ? err.message : 'Search is unavailable.');
          setResults([]);
          setStatus('error');
          setIsStale(false);
        });
    }, debounceMs);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, enabled, limit, withMargin, debounceMs, minChars, maxWaitMs, nonce]);

  return useMemo(
    () => ({ status, results, error, errorCode, resolvedQuery, isStale, clear, refresh }),
    [status, results, error, errorCode, resolvedQuery, isStale, clear, refresh],
  );
}
