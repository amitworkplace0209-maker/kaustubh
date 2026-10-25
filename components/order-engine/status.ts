'use client';

/**
 * Order Engine presentation primitives.
 *
 * The single most important thing this file enforces: a WORKING order
 * (PENDING / OPEN / TRIGGER_PENDING / PARTIALLY_FILLED) is never styled or
 * labelled like an executed one. Accepted-but-unfilled is the state a broker
 * spends most of an order's life in, and rendering it as "done" is how a
 * rejected order ends up looking like a fill.
 */
import type { CanonicalOrder, CanonicalOrderStatus } from '@/lib/api';

export const STATUS_LABEL: Record<CanonicalOrderStatus, string> = {
  PENDING: 'Pending',
  OPEN: 'Working',
  TRIGGER_PENDING: 'Trigger pending',
  PARTIALLY_FILLED: 'Partial',
  COMPLETE: 'Executed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  UNKNOWN: 'Unknown',
};

/** Working = accepted by the broker, still owed a fill. Not executed. */
export function isWorking(status: CanonicalOrderStatus): boolean {
  return status === 'PENDING' || status === 'OPEN' || status === 'TRIGGER_PENDING';
}

/** Terminal = the broker will not change this row again. */
export function isTerminal(status: CanonicalOrderStatus): boolean {
  return status === 'COMPLETE' || status === 'REJECTED' || status === 'CANCELLED';
}

/** Cancelling is only meaningful while the broker still owes a fill. */
export function canCancel(order: CanonicalOrder): boolean {
  return isWorking(order.status) || order.status === 'PARTIALLY_FILLED';
}

export function canModify(order: CanonicalOrder): boolean {
  return canCancel(order);
}

export function statusTone(
  status: CanonicalOrderStatus,
): 'emerald' | 'amber' | 'sky' | 'rose' | 'slate' {
  switch (status) {
    case 'COMPLETE':
      return 'emerald';
    case 'REJECTED':
      return 'rose';
    case 'CANCELLED':
      return 'slate';
    case 'PARTIALLY_FILLED':
      return 'sky';
    default:
      return 'amber';
  }
}

export const TONE_CLASS: Record<
  'emerald' | 'amber' | 'sky' | 'rose' | 'slate',
  string
> = {
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  sky: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  slate: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
};

/**
 * Why a working order has not executed. Prefers the terminal's own reason so a
 * broker's message is never replaced with a generic one (doc §21).
 */
export function workingReason(order: CanonicalOrder): string {
  if (order.status === 'COMPLETE') {
    return order.averagePrice > 0
      ? `Executed ${order.filledQuantity}/${order.quantity} @ ${order.averagePrice.toFixed(2)}`
      : 'Executed';
  }
  if (order.reason) return order.reason;
  if (order.waitingReason) return order.waitingReason;
  if (order.awaitingLtp) return 'Waiting for live market price (LTP)';
  if (order.status === 'PARTIALLY_FILLED') {
    return `${order.filledQuantity}/${order.quantity} filled · ${order.pendingQuantity} pending`;
  }
  if (order.status === 'TRIGGER_PENDING') return 'Waiting for trigger price';
  if (order.status === 'OPEN') return 'Resting at broker — waiting for LTP to match';
  if (order.status === 'PENDING') return 'Accepted by broker — awaiting execution';
  return '\u2014';
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(Number(n))) return '\u2014';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: digits });
}

export function fmtTime(value: string | null | undefined): string {
  if (!value) return '\u2014';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}