'use client';

// ---- Charge snapshot registry (Phase 9) ----
//
// When a real fill executes:
//   Kotak Neo API -> executed fill -> normalizeExecution -> charge engine
//   -> buildChargeSnapshot -> recordChargeSnapshot HERE.
//
// Snapshots are IMMUTABLE: once recorded, later rate changes never alter them,
// so historical charges stay reproducible. Re-processing the same order is a
// no-op (orderId + tradeId dedupe).

import { buildChargeSnapshot, executionKey, type ChargeSnapshot, type TradeExecution } from '@/lib/charge-engine';

const STORAGE_KEY = 'kaustubh_charge_snapshots';
const MAX_SNAPSHOTS = 5000;

type Listener = () => void;

class ChargeSnapshotStore {
  private byExecution = new Map<string, ChargeSnapshot>();
  private listeners = new Set<Listener>();
  private snapshotList: ChargeSnapshot[] | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const s of list) this.byExecution.set(executionKey(s), s);
      }
    } catch { /* corrupted cache -> start empty */ }
  }

  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      const list = [...this.byExecution.values()];
      // Newest first; hard cap keeps localStorage bounded.
      list.sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_SNAPSHOTS)));
    } catch { /* storage full -> in-memory remains authoritative */ }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    this.snapshotList = null;
    this.persist();
    this.listeners.forEach((l) => l());
  }

  getAll(): ChargeSnapshot[] {
    if (this.snapshotList == null) {
      this.snapshotList = [...this.byExecution.values()]
        .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt));
    }
    return this.snapshotList;
  }

  getForOrder(orderId: string): ChargeSnapshot[] {
    const key = String(orderId).trim();
    return this.getAll().filter((s) => s.orderId === key);
  }

  /** Record computed snapshots. Returns how many NEW snapshots were stored. */
  recordFromExecutions(executions: TradeExecution[]): number {
    let added = 0;
    for (const e of executions) {
      const k = executionKey(e);
      if (this.byExecution.has(k)) continue;
      this.byExecution.set(k, buildChargeSnapshot(e));
      added += 1;
    }
    if (added > 0) this.notify();
    return added;
  }
}

let _store: ChargeSnapshotStore | null = null;

export function getChargeSnapshotStore(): ChargeSnapshotStore {
  if (!_store) _store = new ChargeSnapshotStore();
  return _store;
}
