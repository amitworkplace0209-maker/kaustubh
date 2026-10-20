'use client';

// ---- Persistent target / stop-loss trigger registry ----
//
// Triggers survive navigation and reloads (localStorage-backed). Execution is
// IDEMPOTENT: `claimTrigger` flips ARMED -> TRIGGERED synchronously and only
// once, so no matter how many components evaluate LTP against the same
// trigger, the square-off order is placed at most one time.
//
// Shape per project spec:
//   positionId, side, quantity, triggerPrice, squareOffOrderId, kind

import { useSyncExternalStore } from 'react';

export type TriggerKind = 'TARGET' | 'STOP_LOSS';
export type TriggerStatus = 'ARMED' | 'TRIGGERED' | 'FAILED' | 'CANCELLED';

export interface ArmedTrigger {
  id: string;
  kind: TriggerKind;
  /** Stable position identity this trigger will square off. */
  positionId: string;
  /** Entry order that created this trigger (null for manually armed). */
  orderId: string | null;
  /** Set once the square-off order has been placed (idempotency marker). */
  squareOffOrderId: string | null;
  symbol: string;
  tradingSymbol: string;
  companyName?: string;
  token: string;
  exchange: string;
  exchangeSegment?: string;
  product: string;
  /** ENTRY side; the square-off order goes the opposite way. */
  side: 'BUY' | 'SELL';
  quantity: number;
  triggerPrice: number;
  status: TriggerStatus;
  createdAt: string;
  triggeredAt?: string;
  error?: string;
}

type Listener = () => void;

const STORAGE_KEY = 'kaustubh_trigger_registry';

class TriggerStore {
  private triggers: ArmedTrigger[] = [];
  private listeners = new Set<Listener>();
  private snapshot: ArmedTrigger[] = [];

  constructor() {
    this.load();
    this.rebuildSnapshot();
  }

  private load(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) this.triggers = list;
      }
    } catch { /* corrupted cache -> start empty */ }
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.triggers));
    } catch { /* storage unavailable -> in-memory state remains authoritative */ }
  }

  private rebuildSnapshot(): void {
    // Newest first; TRIGGERED/FAILED/CANCELLED kept for audit + UI badges.
    this.snapshot = [...this.triggers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private notify(): void {
    this.rebuildSnapshot();
    this.persist();
    this.listeners.forEach((l) => l());
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getAll(): ArmedTrigger[] {
    return this.snapshot;
  }

  getArmed(): ArmedTrigger[] {
    return this.snapshot.filter((t) => t.status === 'ARMED');
  }

  get(id: string): ArmedTrigger | undefined {
    return this.triggers.find((t) => t.id === id);
  }

  /** Register a new armed trigger. Duplicate live config for the same
   * position+kind replaces the previous entry instead of stacking. */
  arm(t: Omit<ArmedTrigger, 'id' | 'status' | 'createdAt' | 'squareOffOrderId'>): ArmedTrigger {
    const existing = this.triggers.find(
      (x) => x.positionId === t.positionId && x.kind === t.kind && x.status === 'ARMED',
    );
    if (existing) {
      existing.quantity = t.quantity;
      existing.triggerPrice = t.triggerPrice;
      existing.side = t.side;
      existing.token = t.token;
      existing.product = t.product;
      existing.orderId = t.orderId ?? existing.orderId;
      this.notify();
      return existing;
    }
    const trigger: ArmedTrigger = {
      ...t,
      id: `TRG${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      status: 'ARMED',
      createdAt: new Date().toISOString(),
      squareOffOrderId: null,
    };
    this.triggers.push(trigger);
    this.notify();
    return trigger;
  }

  cancel(id: string): void {
    const t = this.get(id);
    if (t && t.status === 'ARMED') {
      t.status = 'CANCELLED';
      this.notify();
    }
  }

  cancelByPosition(positionId: string): void {
    let changed = false;
    for (const t of this.triggers) {
      if (t.positionId === positionId && t.status === 'ARMED') {
        t.status = 'CANCELLED';
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /**
   * ATOMIC claim — the only gate to placing a square-off order.
   * Returns false when the trigger was already claimed/executed, so duplicate
   * evaluation can never double-fire.
   */
  claimTrigger(id: string): boolean {
    const t = this.get(id);
    if (!t || t.status !== 'ARMED') return false;
    t.status = 'TRIGGERED';
    t.triggeredAt = new Date().toISOString();
    this.notify(); // persisted BEFORE any network call
    return true;
  }

  markFailed(id: string, error: string): void {
    const t = this.get(id);
    if (t && t.status === 'TRIGGERED') {
      t.status = 'FAILED';
      t.error = error;
      this.notify();
    }
  }

  recordSquareOffOrder(id: string, squareOffOrderId: string): void {
    const t = this.get(id);
    if (t) {
      t.squareOffOrderId = squareOffOrderId;
      this.notify();
    }
  }

  /** Drop terminal-state triggers older than 7 days to keep storage lean. */
  prune(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const before = this.triggers.length;
    this.triggers = this.triggers.filter((t) => {
      if (t.status === 'ARMED') return true;
      return new Date(t.triggeredAt ?? t.createdAt).getTime() > cutoff;
    });
    if (this.triggers.length !== before) this.notify();
  }
}

let _store: TriggerStore | null = null;

export function getTriggerStore(): TriggerStore {
  if (!_store) _store = new TriggerStore();
  return _store;
}

function subscribeStore(listener: Listener): () => void {
  return getTriggerStore().subscribe(listener);
}

function getSnapshot(): ArmedTrigger[] {
  return getTriggerStore().getAll();
}

const EMPTY: ArmedTrigger[] = [];

export function useTriggers(): ArmedTrigger[] {
  return useSyncExternalStore(subscribeStore, getSnapshot, () => EMPTY);
}

/**
 * Pure evaluation rule shared by every monitor:
 * LONG entry (BUY): target fires when LTP >= target, SL fires when LTP <= sl.
 * SHORT entry (SELL): inverted.
 */
export function triggerHit(t: ArmedTrigger, ltp: number): boolean {
  if (!(ltp > 0) || t.status !== 'ARMED' || !(t.triggerPrice > 0)) return false;
  const isLong = t.side === 'BUY';
  if (t.kind === 'TARGET') return isLong ? ltp >= t.triggerPrice : ltp <= t.triggerPrice;
  return isLong ? ltp <= t.triggerPrice : ltp >= t.triggerPrice;
}
