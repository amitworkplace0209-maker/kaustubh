'use client';

import { useSyncExternalStore } from 'react';

/**
 * Global-search → Market Watch symbol handoff.
 *
 * The command palette searched the canonical instrument index and then linked
 * to `/trading/market-watch?search=<symbol>` — but NO page reads that query
 * parameter, so picking a stock navigated somewhere and silently dropped the
 * selection. This module carries the picked instrument across the navigation
 * instead, and `components/market-watch/market-watch-live.tsx` consumes it
 * (one-shot) and opens the real symbol detail it already supports.
 *
 * Same shape and rationale as `lib/basket-draft.ts` (Trade → Basket): pure UI
 * state, no token and no account data, so mirroring it in sessionStorage is
 * safe and survives a reload. The in-memory value is the source of truth for
 * the running tab.
 *
 * It is a HANDOFF, not a cache: `takePendingSymbol()` always clears, so a
 * pending symbol can never be re-applied on a later, unrelated visit.
 */

export type PendingSymbol = {
  symbol: string;
  /** Instrument token when the Search Engine supplied one. Preferred by the
   *  detail endpoint, which resolves reliably on the numeric token. */
  token?: string;
  /** Display name, used only to focus the page's own search field. */
  name?: string;
  /** Epoch ms the pick was made; a stale handoff is ignored after 2 minutes. */
  at: number;
};

const STORAGE_KEY = 'kaustubh.pending.symbol';

/** A handoff older than this is treated as abandoned and dropped. */
const MAX_AGE_MS = 2 * 60 * 1000;

let current: PendingSymbol | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (typeof window === 'undefined') return;
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PendingSymbol;
    if (parsed && typeof parsed.symbol === 'string' && parsed.symbol) current = parsed;
  } catch {
    /* corrupted handoff is not worth surfacing — start clean */
  }
}

function persist(): void {
  try {
    if (typeof window === 'undefined') return;
    if (current) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled (private mode) — the in-memory handoff still works */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PendingSymbol | null {
  hydrate();
  return current;
}

/** Hand a searched instrument to the destination page. */
export function setPendingSymbol(next: Omit<PendingSymbol, 'at'>): void {
  hydrate();
  current = { ...next, at: Date.now() };
  persist();
  emit();
}

/** Read + clear the handoff (one-shot consumption by the destination page). */
export function takePendingSymbol(): PendingSymbol | null {
  hydrate();
  const next = current;
  current = null;
  // A stale/abandoned pick is dropped rather than opened out of nowhere.
  if (next && Date.now() - next.at > MAX_AGE_MS) {
    persist();
    emit();
    return null;
  }
  if (next) {
    persist();
    emit();
  }
  return next;
}

/** Subscribe to the current handoff (unused by the UI today, kept for parity
 *  with `useBasketDraft` so a future preview needs no new primitive). */
export function usePendingSymbol(): PendingSymbol | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}