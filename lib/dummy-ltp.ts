'use client';

let pending = new Map<string, number>();
let timer: number | null = null;
const FLUSH_MS = 1500;
const MAX_BATCH = 80;

export function feedDummyLtp(symbol: string, ltp: number) {
  if (!symbol || !Number.isFinite(ltp) || ltp <= 0) return;
  pending.set(symbol.toUpperCase(), ltp);
  if (timer == null) {
    timer = window.setTimeout(flush, FLUSH_MS);
  }
}

async function flush() {
  timer = null;
  if (pending.size === 0) return;
  const entries = Array.from(pending.entries()).slice(0, MAX_BATCH).map(([symbol, ltp]) => ({ symbol, ltp }));
  pending = new Map<string, number>();
  try {
    const { TradingService } = await import('@/lib/trading-service');
    await TradingService.updateLtp(entries);
  } catch {
    /* best effort: refresh re-pushes on next real tick */
  }
}

export function clearDummyLtp() {
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
  pending = new Map<string, number>();
}