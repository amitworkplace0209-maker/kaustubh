// ---- CANONICAL CHARGE ENGINE (the ONE source of truth for the whole app) ----
//
import { istDateKey } from './ist.ts';
//
// Every page and every mode (API + demo) computes charges through this module:
// Dashboard, Positions, Orders, Order History, Portfolio, Holdings,
// Trading Calculator and the Order Form.
//
// Statutory rates live in config/statutory-charges.ts, brokerage plans in
// config/brokerage.ts. Nothing here is hard-coded per component.
//
// Pure module — no React, no browser APIs — so it is unit-testable directly.

import {
  resolveSttRate,
  resolveExchangeTxnRate,
  resolveSebiRate,
  resolveStampDutyRate,
  resolveGstRate,
} from '../config/statutory-charges.ts';
import { resolveBrokerageProfile } from '../config/brokerage.ts';

/** Bump whenever any rate table or formula changes; snapshots record it so
 * historical charges stay reproducible even after future rate changes. */
export const CALCULATION_VERSION = '2024-10-01.1';

export type Side = 'BUY' | 'SELL';
export type ChargeSource = 'broker-reported' | 'configured-rules';

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDateOf(ts: string | Date | undefined | null): string {
  const d = ts == null ? new Date() : new Date(ts);
  return isNaN(d.getTime()) ? istDateKey() : istDateKey(d);
}

// ---------------------------------------------------------------------------
// Phase 1 - canonical normalized trade execution
// ---------------------------------------------------------------------------

/**
 * One FILLED/EXECUTED trade. Only executions enter the calculator;
 * pending/rejected/cancelled orders never generate charges.
 * Partial fills are supported naturally (one entry per fill).
 */
export interface TradeExecution {
  orderId: string;
  tradeId: string;
  symbol: string;
  exchange: string;
  segment?: string;
  product: string;
  side: Side;
  quantity: number;
  executedPrice: number;
  executedValue: number;
  timestamp: string;
}

/** Stable unique execution identifier — prevents duplicate calculations. */
export function executionKey(e: Pick<TradeExecution, 'orderId' | 'tradeId'>): string {
  return `${String(e.orderId).trim()}#${String(e.tradeId || '').trim()}`;
}

const EXECUTED_STATUSES = new Set(['complete', 'filled', 'executed', 'partial']);

/** True when an order status represents a fill that must be charged. */
export function isExecutedStatus(status: unknown): boolean {
  return EXECUTED_STATUSES.has(String(status ?? '').toLowerCase().trim());
}

function normSym(v: unknown): string {
  return String(v ?? '').split('-')[0].trim().toUpperCase();
}

function toSide(v: unknown): Side {
  return String(v ?? '').toUpperCase().includes('SELL') ? 'SELL' : 'BUY';
}

/** Normalize a raw broker/demo row into a TradeExecution, or null when the
 * row is not an executed fill (pending/rejected/cancelled/zero qty or price). */
export function normalizeExecution(raw: Record<string, unknown>): TradeExecution | null {
  if (!isExecutedStatus(raw.status)) return null;
  const quantity = Number(raw.filled_quantity ?? raw.fldQty ?? raw.quantity ?? raw.qty ?? 0);
  const executedPrice = Number(
    raw.average_traded_price ?? raw.avgPrc ?? raw.avg_price ?? raw.price ?? 0,
  );
  if (!(quantity > 0) || !(executedPrice > 0)) return null;
  const orderId = String(raw.n_ord_no ?? raw.order_id ?? raw.orderId ?? raw.ordNo ?? '').trim();
  if (!orderId) return null;
  return {
    orderId,
    tradeId: String(raw.trade_id ?? raw.tradeId ?? raw.trdNo ?? '').trim(),
    symbol: normSym(raw.trdSym_clean ?? raw.trdSym ?? raw.trading_symbol ?? raw.sym_clean ?? raw.sym ?? raw.symbol),
    exchange: String(raw.exSeg_clean ?? raw.exSeg ?? raw.exchange_segment ?? raw.exchange ?? '').toUpperCase(),
    segment: String(raw.segment ?? '').toUpperCase() || undefined,
    product: String(raw.prod_clean ?? raw.product ?? raw.prod ?? '').toUpperCase(),
    side: toSide(raw.transaction_type ?? raw.trnsTp ?? raw.side),
    quantity,
    executedPrice,
    executedValue: r2(executedPrice * quantity),
    timestamp: String(raw.order_date ?? raw.ordDtTm ?? raw.flDtTm ?? new Date().toISOString()),
  };
}

/** Drop duplicate executions (same orderId+tradeId) before any math. */
export function dedupeExecutions(executions: TradeExecution[]): TradeExecution[] {
  const seen = new Map<string, TradeExecution>();
  for (const e of executions) {
    const key = executionKey(e);
    const prev = seen.get(key);
    // Prefer the larger fill if the same id appears with different quantities.
    if (!prev || e.quantity > prev.quantity) seen.set(key, e);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Individual calculators (Phase 3-8) — each returns a named part
// ---------------------------------------------------------------------------

export type BrokerageResult = { brokerage: number; profileName: string; pricingType: string };

export function calculateBrokerage(params: {
  product?: string;
  turnover: number;
  timestamp?: string | Date | null;
  broker?: string | null;
}): BrokerageResult {
  const turnover = Math.max(0, params.turnover || 0);
  if (turnover <= 0) return { brokerage: 0, profileName: '', pricingType: '' };
  const { profile } = resolveBrokerageProfile({ product: params.product, timestamp: params.timestamp, broker: params.broker ?? null });
  let fee = 0;
  if (profile.pricingType === 'FLAT_PER_ORDER') {
    fee = profile.flatPerExecutedOrder ?? 0;
  } else {
    fee = turnover * (profile.percentageRate ?? 0);
  }
  if (profile.minimumBrokerage > 0 && fee < profile.minimumBrokerage) fee = profile.minimumBrokerage;
  if (profile.maximumBrokerage != null && fee > profile.maximumBrokerage) fee = profile.maximumBrokerage;
  return { brokerage: r2(fee), profileName: profile.profileName, pricingType: profile.pricingType };
}

export function calculateSTT(params: {
  product?: string;
  side: Side;
  turnover: number;
  timestamp?: string | Date | null;
}): number {
  const turnover = Math.max(0, params.turnover || 0);
  if (turnover <= 0) return 0;
  const { rate } = resolveSttRate({
    product: params.product ?? '',
    side: params.side,
    timestamp: params.timestamp,
  });
  return r2(turnover * rate);
}

export function calculateExchangeCharges(params: {
  exchange?: string;
  turnover: number;
  timestamp?: string | Date | null;
}): number {
  const turnover = Math.max(0, params.turnover || 0);
  if (turnover <= 0) return 0;
  const { rate } = resolveExchangeTxnRate({ exchange: params.exchange ?? '', timestamp: params.timestamp });
  return r2(turnover * rate);
}

export function calculateSEBICharges(params: {
  turnover: number;
  timestamp?: string | Date | null;
}): number {
  const turnover = Math.max(0, params.turnover || 0);
  if (turnover <= 0) return 0;
  const { rate } = resolveSebiRate(params.timestamp);
  return r2(turnover * rate);
}

export function calculateStampDuty(params: {
  product?: string;
  side: Side;
  turnover: number;
  timestamp?: string | Date | null;
}): number {
  const turnover = Math.max(0, params.turnover || 0);
  if (turnover <= 0) return 0;
  const { rate } = resolveStampDutyRate({
    product: params.product ?? '',
    side: params.side,
    timestamp: params.timestamp,
  });
  return r2(turnover * rate);
}

/**
 * Phase 5 — GST applies to the TAXABLE SERVICE BASE
 * (brokerage + exchange transaction charges + SEBI fee + other taxable),
 * NEVER to total trade value.
 */
export function gstTaxableBase(parts: {
  brokerage: number;
  exchangeTransactionCharges: number;
  sebiCharges: number;
  otherCharges?: number;
}): number {
  return r2(
    Math.max(0, parts.brokerage) +
    Math.max(0, parts.exchangeTransactionCharges) +
    Math.max(0, parts.sebiCharges) +
    Math.max(0, parts.otherCharges ?? 0),
  );
}

export function calculateGST(params: {
  brokerage: number;
  exchangeTransactionCharges: number;
  sebiCharges: number;
  otherCharges?: number;
  timestamp?: string | Date | null;
}): { gst: number; taxableBase: number } {
  const base = gstTaxableBase(params);
  if (base <= 0) return { gst: 0, taxableBase: base };
  const { rate } = resolveGstRate(params.timestamp);
  return { gst: r2(base * rate), taxableBase: base };
}

export function calculateTotalCharges(parts: {
  brokerage: number;
  stt: number;
  exchangeTransactionCharges: number;
  sebiCharges: number;
  stampDuty: number;
  gst: number;
  otherCharges?: number;
}): number {
  return r2(
    parts.brokerage + parts.stt + parts.exchangeTransactionCharges +
    parts.sebiCharges + parts.stampDuty + parts.gst + (parts.otherCharges ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Full calculation (Phase 2 result contract)
// ---------------------------------------------------------------------------

export interface CalculateChargesInput {
  side: Side;
  quantity: number;
  /** Executed/expected price. Market orders pass LTP. */
  price: number;
  product?: string;
  exchange?: string;
  timestamp?: string | Date | null;
  broker?: string | null;
  /** Provider-supplied total, preferred over configured rules when present. */
  brokerReportedTotal?: number | null;
}

export interface ChargeCalculation {
  turnover: number;
  brokerage: number;
  stt: number;
  exchangeTransactionCharges: number;
  sebiCharges: number;
  stampDuty: number;
  gst: number;
  otherCharges: number;
  totalCharges: number;

  gstTaxableBase: number;
  calculationVersion: string;
  effectiveDate: string;
  source: ChargeSource;
}

/** THE single-leg charge calculation used everywhere in the app. */
export function calculateCharges(input: CalculateChargesInput): ChargeCalculation {
  const quantity = Math.max(0, Number(input.quantity) || 0);
  const price = Math.max(0, Number(input.price) || 0);
  const turnover = r2(price * quantity);

  if (turnover <= 0) {
    return {
      turnover: 0, brokerage: 0, stt: 0, exchangeTransactionCharges: 0,
      sebiCharges: 0, stampDuty: 0, gst: 0, otherCharges: 0, totalCharges: 0,
      gstTaxableBase: 0,
      calculationVersion: CALCULATION_VERSION,
      effectiveDate: isoDateOf(input.timestamp),
      source: 'configured-rules',
    };
  }

  const ts = input.timestamp ?? new Date();
  const brokerage = calculateBrokerage({ product: input.product, turnover, timestamp: ts, broker: input.broker ?? null }).brokerage;
  const stt = calculateSTT({ product: input.product, side: input.side, turnover, timestamp: ts });
  const exchangeTransactionCharges = calculateExchangeCharges({ exchange: input.exchange, turnover, timestamp: ts });
  const sebiCharges = calculateSEBICharges({ turnover, timestamp: ts });
  const stampDuty = calculateStampDuty({ product: input.product, side: input.side, turnover, timestamp: ts });
  const otherCharges = 0;
  const gstInfo = calculateGST({
    brokerage, exchangeTransactionCharges, sebiCharges, otherCharges, timestamp: ts,
  });

  let totalCharges = calculateTotalCharges({
    brokerage, stt, exchangeTransactionCharges, sebiCharges, stampDuty, gst: gstInfo.gst, otherCharges,
  });

  let source: ChargeSource = 'configured-rules';
  // Priority 1: when the broker reports the authoritative total we keep our
  // line items for display but anchor the total to the reported value.
  if (input.brokerReportedTotal != null && Number.isFinite(Number(input.brokerReportedTotal))) {
    totalCharges = r2(Math.max(0, Number(input.brokerReportedTotal)));
    source = 'broker-reported';
  }

  return {
    turnover,
    brokerage, stt, exchangeTransactionCharges, sebiCharges, stampDuty,
    gst: gstInfo.gst, otherCharges, totalCharges,
    gstTaxableBase: gstInfo.taxableBase,
    calculationVersion: CALCULATION_VERSION,
    effectiveDate: isoDateOf(ts),
    source,
  };
}

// ---------------------------------------------------------------------------
// Multi-fill aggregation with duplicate prevention
// ---------------------------------------------------------------------------

export interface AggregatedCharges extends ChargeCalculation {
  orderCount: number;
  executionCount: number;
}

/** Aggregate many fills (possibly partial, possibly duplicated) into totals. */
export function calculateExecutionCharges(executions: TradeExecution[]): AggregatedCharges {
  const unique = dedupeExecutions(executions).filter(
    (e) => e.quantity > 0 && e.executedPrice > 0,
  );

  const totals = {
    turnover: 0, brokerage: 0, stt: 0, exchangeTransactionCharges: 0,
    sebiCharges: 0, stampDuty: 0, gst: 0, otherCharges: 0,
  };
  for (const e of unique) {
    const c = calculateCharges({
      side: e.side,
      quantity: e.quantity,
      price: e.executedPrice,
      product: e.product,
      exchange: e.exchange,
      timestamp: e.timestamp,
    });
    totals.turnover += c.turnover;
    totals.brokerage += c.brokerage;
    totals.stt += c.stt;
    totals.exchangeTransactionCharges += c.exchangeTransactionCharges;
    totals.sebiCharges += c.sebiCharges;
    totals.stampDuty += c.stampDuty;
    totals.gst += c.gst;
    totals.otherCharges += c.otherCharges;
  }

  const rounded = {
    turnover: r2(totals.turnover),
    brokerage: r2(totals.brokerage),
    stt: r2(totals.stt),
    exchangeTransactionCharges: r2(totals.exchangeTransactionCharges),
    sebiCharges: r2(totals.sebiCharges),
    stampDuty: r2(totals.stampDuty),
    gst: r2(totals.gst),
    otherCharges: r2(totals.otherCharges),
  };
  return {
    ...rounded,
    totalCharges: calculateTotalCharges(rounded),
    gstTaxableBase: gstTaxableBase(rounded),
    calculationVersion: CALCULATION_VERSION,
    effectiveDate: istDateKey(),
    source: 'configured-rules',
    orderCount: new Set(unique.map((e) => e.orderId)).size,
    executionCount: unique.length,
  };
}

// ---------------------------------------------------------------------------
// Phase 9 — charge snapshot (immutable once recorded)
// ---------------------------------------------------------------------------

export interface ChargeSnapshot extends ChargeCalculation {
  orderId: string;
  tradeId: string;
  symbol: string;
  segment?: string;
  side: Side;
  quantity: number;
  executedPrice: number;
  calculatedAt: string;
}

/** Build an immutable snapshot for one executed fill. */
export function buildChargeSnapshot(e: TradeExecution): ChargeSnapshot {
  const c = calculateCharges({
    side: e.side,
    quantity: e.quantity,
    price: e.executedPrice,
    product: e.product,
    exchange: e.exchange,
    timestamp: e.timestamp,
  });
  return {
    orderId: e.orderId,
    tradeId: e.tradeId,
    symbol: e.symbol,
    segment: e.segment,
    side: e.side,
    quantity: e.quantity,
    executedPrice: e.executedPrice,
    turnover: c.turnover,
    brokerage: c.brokerage,
    stt: c.stt,
    exchangeTransactionCharges: c.exchangeTransactionCharges,
    sebiCharges: c.sebiCharges,
    stampDuty: c.stampDuty,
    gst: c.gst,
    otherCharges: c.otherCharges,
    totalCharges: c.totalCharges,
    gstTaxableBase: c.gstTaxableBase,
    calculationVersion: c.calculationVersion,
    effectiveDate: c.effectiveDate,
    source: c.source,
    calculatedAt: new Date().toISOString(),
  };
}
