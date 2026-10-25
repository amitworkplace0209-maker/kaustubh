// ---- Canonical charge calculation facade (ONE source for the whole app) ----
//
// All MATH lives in lib/charge-engine.ts (which reads config/brokerage.ts +
// config/statutory-charges.ts). This module keeps the app-facing helpers:
// broker-charge extraction, Kotak/demo row -> execution normalization and
// per-position aggregation with order-level dedupe.
//
// A missing charge field NEVER becomes 0 â€” callers receive known=false and
// must render "Pending broker data" instead of â‚¹0.00.

import {
  calculateCharges,
  normalizeExecution,
  type TradeExecution,
} from './charge-engine.ts';

export { CALCULATION_VERSION } from './charge-engine.ts';

export type ChargeBreakdown = {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  otherCharges: number;
  totalCharges: number;
};

export type ChargesResult = {
  breakdown: ChargeBreakdown;
  /** Unique executed orders that contributed (each orderId counted once). */
  orderCount: number;
  /** True when EVERY contributing order carried a provider-supplied charge. */
  confirmed: boolean;
  /** False when no executed order could be priced -> display "Pending". */
  known: boolean;
};

export function emptyBreakdown(): ChargeBreakdown {
  return {
    brokerage: 0, stt: 0, exchangeCharges: 0, gst: 0,
    sebiCharges: 0, stampDuty: 0, otherCharges: 0, totalCharges: 0,
  };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalized clean symbol: "IDBI-EQ" -> "IDBI". */
export function normSymbol(v: unknown): string {
  return String(v ?? '').split('-')[0].trim().toUpperCase();
}

/** Stable position key used to map executed orders onto positions. */
export function positionKey(symbol: unknown, product: unknown): string {
  return `${normSymbol(symbol)}|${String(product ?? '').trim().toUpperCase()}`;
}

/**
 * Estimate charges for one real fill via THE canonical engine.
 * Optional product/exchange/timestamp make rates segment/exchange/date aware;
 * omitting them preserves the legacy call signature.
 */
export function estimateFillCharges(
  side: 'BUY' | 'SELL',
  price: number,
  quantity: number,
  ctx?: { product?: string; exchange?: string; timestamp?: string | Date | null },
): ChargeBreakdown {
  const c = calculateCharges({
    side, price, quantity,
    product: ctx?.product,
    exchange: ctx?.exchange,
    timestamp: ctx?.timestamp ?? new Date(),
  });
  return {
    brokerage: c.brokerage,
    stt: c.stt,
    exchangeCharges: c.exchangeTransactionCharges,
    gst: c.gst,
    sebiCharges: c.sebiCharges,
    stampDuty: c.stampDuty,
    otherCharges: c.otherCharges,
    totalCharges: c.totalCharges,
  };
}

function pickNum(r: Record<string, unknown>, names: string[]): number | null {
  for (const k of names) {
    const v = r[k];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Priority 1: broker-provided charges on an order row.
 * Returns null when the broker sent no charge field at all (never invents 0).
 */
export function extractBrokerCharges(raw: unknown): ChargeBreakdown | null {
  const r = (raw || {}) as Record<string, unknown>;
  const brokerage = pickNum(r, ['brokerage', 'brkAmt', 'brk_amt']);
  const stt = pickNum(r, ['stt', 'stax', 'STT']);
  const exchangeCharges = pickNum(r, [
    'exchange_charges', 'exchangeCharges', 'transaction_charges', 'trdChrg', 'trdCharges', 'exchChrg',
  ]);
  const gst = pickNum(r, ['gst', 'gst_charges', 'gstCharges']);
  const sebiCharges = pickNum(r, ['sebi', 'sebi_charges', 'sebiCharges', 'sebi_turnover_fees']);
  const stampDuty = pickNum(r, ['stamp_duty', 'stampDuty', 'stamp']);
  const otherCharges = pickNum(r, ['other_charges', 'otherCharges']);
  const totalField = pickNum(r, ['total_charges', 'totalCharges', 'totalCharge']);

  const parts = [brokerage, stt, exchangeCharges, gst, sebiCharges, stampDuty, otherCharges];
  if (parts.every((p) => p == null) && totalField == null) return null;

  const bd = emptyBreakdown();
  bd.brokerage = brokerage ?? 0;
  bd.stt = stt ?? 0;
  bd.exchangeCharges = exchangeCharges ?? 0;
  bd.gst = gst ?? 0;
  bd.sebiCharges = sebiCharges ?? 0;
  bd.stampDuty = stampDuty ?? 0;
  bd.otherCharges = otherCharges ?? 0;
  const summed = parts.reduce<number>((s, p) => s + (p ?? 0), 0);
  bd.totalCharges = r2(totalField ?? summed);
  return bd;
}

/** One executed fill normalized for charge math (BUY/SELL, price, qty, key). */
export type ExecutedTrade = {
  id: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  symbol: string;
  product: string;
  exchange: string;
  ts: string;
  /** Provider-supplied charges; null means "estimate from configured rules". */
  charges: ChargeBreakdown | null;
};

/** Kotak Neo order-book/history row -> ExecutedTrade (null when not executed). */
export function kotakRowToTrade(raw: unknown): ExecutedTrade | null {
  const r = (raw || {}) as Record<string, unknown>;
  const e: TradeExecution | null = normalizeExecution(r);
  if (!e) return null;
  return {
    id: e.orderId,
    side: e.side,
    price: e.executedPrice,
    quantity: e.quantity,
    symbol: e.symbol,
    product: e.product,
    exchange: e.exchange,
    ts: e.timestamp,
    charges: extractBrokerCharges(r),
  };
}

/** Structural subset of the demo engine order (avoids an import cycle). */
export type DemoOrderLike = {
  orderId: string;
  transactionType: 'BUY' | 'SELL';
  averageTradedPrice: number;
  price: number;
  filledQuantity: number;
  status: string;
  symbol: string;
  tradingSymbol: string;
  product: string;
  exchange: string;
  exchangeSegment: string;
  orderDate: string;
  charges: {
    brokerage: number; stt: number; exchangeTxn: number;
    gst: number; sebi: number; stampDuty: number; total: number;
  } | null;
};

/** Demo engine executed order -> ExecutedTrade (engine charges are authoritative). */
export function demoOrderToTrade(o: DemoOrderLike): ExecutedTrade | null {
  if (o.status !== 'COMPLETE' || !(o.filledQuantity > 0)) return null;
  const price = o.averageTradedPrice > 0 ? o.averageTradedPrice : o.price;
  if (!(price > 0)) return null;
  const c = o.charges ?? null;
  return {
    id: o.orderId,
    side: o.transactionType,
    price,
    quantity: o.filledQuantity,
    symbol: normSymbol(o.tradingSymbol || o.symbol),
    product: String(o.product || '').toUpperCase(),
    exchange: String(o.exchangeSegment || o.exchange || '').toUpperCase(),
    ts: o.orderDate,
    charges: c
      ? {
          brokerage: c.brokerage, stt: c.stt, exchangeCharges: c.exchangeTxn,
          gst: c.gst, sebiCharges: c.sebi, stampDuty: c.stampDuty,
          otherCharges: 0, totalCharges: c.total,
        }
      : null,
  };
}

function addInto(target: ChargeBreakdown, part: ChargeBreakdown): void {
  target.brokerage = r2(target.brokerage + part.brokerage);
  target.stt = r2(target.stt + part.stt);
  target.exchangeCharges = r2(target.exchangeCharges + part.exchangeCharges);
  target.gst = r2(target.gst + part.gst);
  target.sebiCharges = r2(target.sebiCharges + part.sebiCharges);
  target.stampDuty = r2(target.stampDuty + part.stampDuty);
  target.otherCharges = r2(target.otherCharges + part.otherCharges);
  target.totalCharges = r2(target.totalCharges + part.totalCharges);
}

/**
 * THE single charge calculation. Dedupes by orderId first (a charge can never
 * be counted twice), prefers provider charges per order, falls back to the
 * configured project rules on the REAL fill price/qty.
 */
export function calculatePositionCharges(trades: ExecutedTrade[]): ChargesResult {
  const unique = new Map<string, ExecutedTrade>();
  for (const t of trades) {
    const prev = unique.get(t.id);
    if (!prev || t.quantity > prev.quantity) unique.set(t.id, t);
  }
  const list = [...unique.values()].filter((t) => t.quantity > 0 && t.price > 0);

  const breakdown = emptyBreakdown();
  let confirmed = list.length > 0;
  for (const t of list) {
    if (t.charges == null) confirmed = false;
    addInto(breakdown, t.charges ?? estimateFillCharges(t.side, t.price, t.quantity));
  }
  return { breakdown, orderCount: list.length, confirmed, known: list.length > 0 };
}

/** Synthesize a confirmed result from a backend/broker position-level value. */
export function chargesFromPositionValue(total: number): ChargesResult {
  const breakdown = emptyBreakdown();
  breakdown.totalCharges = r2(Math.max(0, total));
  return { breakdown, orderCount: 0, confirmed: true, known: true };
}
