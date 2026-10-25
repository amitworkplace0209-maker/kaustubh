'use client';

let pending = new Map<string, number>();
let timer: number | null = null;
/**
 * True while a batch POST is on the wire. The paper-engine LTP update can take
 * seconds when Mongo is slow; without this guard the 1.5 s timer kept firing
 * and stacked overlapping /api/trade/demo/ltp requests on top of each other.
 */
let flushing = false;
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
  if (pending.size === 0 || flushing) return;
  const batch = Array.from(pending.entries()).slice(0, MAX_BATCH);
  // Remove only what this batch carries; symbols fed while the POST is in
  // flight stay queued for the next flush instead of being dropped or merged
  // into a second concurrent request.
  for (const [symbol] of batch) pending.delete(symbol);
  flushing = true;
  try {
    const { TradingService } = await import('@/lib/trading-service');
    await TradingService.updateLtp(batch.map(([symbol, ltp]) => ({ symbol, ltp })));
  } catch {
    /* best effort: refresh re-pushes on next real tick */
  } finally {
    flushing = false;
    if (pending.size > 0 && timer == null) {
      timer = window.setTimeout(flush, FLUSH_MS);
    }
  }
}

export function clearDummyLtp() {
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
  pending = new Map<string, number>();
}