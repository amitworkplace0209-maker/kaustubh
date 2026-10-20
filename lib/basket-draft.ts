'use client';

import { useSyncExternalStore } from 'react';

/**
 * Trade → Basket handoff.
 *
 * The Trade workspace composes legs locally ("Add {symbol} to Basket"); the
 * Basket workspace used to open empty, so the composed basket was silently
 * dropped. This module carries the draft across that navigation.
 *
 * The draft is UI state only (instrument + ticket fields the user typed) — no
 * session token, no account data — so it is safe to mirror in sessionStorage
 * for a full page load. The in-memory value is the source of truth for the
 * running tab; sessionStorage only survives a reload.
 */

export type BasketDraftLeg = {
  symbol: string;
  token: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: string;
  price: string;
  triggerPrice: string;
};

export type BasketDraft = {
  name: string;
  legs: BasketDraftLeg[];
};

const STORAGE_KEY = 'kaustubh.basket.draft';

let current: BasketDraft | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (typeof window === 'undefined') return;
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as BasketDraft;
    if (parsed && Array.isArray(parsed.legs)) current = parsed;
  } catch {
    /* corrupted draft is not worth surfacing — start clean */
  }
}

function persist(): void {
  try {
    if (typeof window === 'undefined') return;
    if (current) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled (private mode) — the in-memory draft still works */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  hydrate();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): BasketDraft | null {
  hydrate();
  return current;
}

/** Store the basket composed on the Trade page. Pass `null` to clear. */
export function setBasketDraft(draft: BasketDraft | null): void {
  hydrate();
  current = draft && draft.legs.length > 0 ? draft : null;
  persist();
  emit();
}

/** Read + clear the draft (one-shot consumption by the Basket workspace). */
export function takeBasketDraft(): BasketDraft | null {
  hydrate();
  const draft = current;
  current = null;
  persist();
  emit();
  return draft;
}

export function clearBasketDraft(): void {
  setBasketDraft(null);
}

/** Subscribe to the current draft (for components that preview it live). */
export function useBasketDraft(): BasketDraft | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
