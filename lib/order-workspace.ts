'use client';

/** Pure, testable helpers for the Orders workspace.
 *
 *  Everything here is presentation/validation math only. Broker-specific
 *  numbers (LTP, margins, charges, risk verdicts) always come from the
 *  backend (Search Engine, /api/terminal/*, Risk Engine, /api/dummy/preview)
 *  — nothing here invents market data.
 */

/** Canonical Trading sub-routes (the sidebar group is the primary navigation).
 *  There is NO standalone Trading/Orders page — `orders` only exists as a
 *  legacy alias that resolves to the default Trade page. */
export const ORDER_ROUTES = {
  orders: '/trading/trade',
  trade: '/trading/trade',
  suggestion: '/trading/suggestion',
  history: '/trading/history',
} as const;

/** Keyboard navigation for the suggestion list. Returns the next active index. */
export function nextSuggestionIndex(
  current: number,
  length: number,
  direction: 'up' | 'down',
): number {
  if (length <= 0) return -1;
  if (direction === 'down') return current < length - 1 ? current + 1 : 0;
  return current > 0 ? current - 1 : length - 1;
}

/** Order value = quantity × effective price (either side). Null when unknown. */
export function orderValue(quantity: number, price: number | null): number | null {
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  if (price == null || !(price > 0)) return null;
  return quantity * price;
}

/* ---------------------------------------------------------------------------
 * Margin-based sizing
 *
 * The order ticket is driven by the margin the user wants to commit, not by a
 * raw share count typed against the LTP. Example: LTP ₹200 with a ₹40
 * per-share MIS margin and ₹400 committed ⇒ 400 / 40 = 10 shares. Using the LTP
 * instead (400 / 200 = 2) is what produced "qty is right but the order value
 * isn't" — the divisor must be the MARGIN per share, never the price.
 * ------------------------------------------------------------------------- */

/** Margin block per share as a fraction of price, per product. Mirrors the
 *  dummy engine's own rule (api/demo.py: MIS ⇒ 20%, delivery ⇒ full value).
 *  CASH = full-payment cash delivery (factor 1.0), settles into Holdings. */
export const DEFAULT_MARGIN_FACTOR: Record<string, number> = {
  MIS: 0.2,
  // Same product under its other name — the dummy engine treats them alike.
  INTRADAY: 0.2,
  CNC: 1,
  CASH: 1,
  CO: 1,
  MARGIN: 1,
  NRML: 1,
};

/** Margin factor for a product, defaulting to full value for unknown products. */
export function marginFactor(product: string): number {
  return DEFAULT_MARGIN_FACTOR[String(product ?? '').trim().toUpperCase()] ?? 1;
}

export interface MarginPerShareInput {
  /** Effective price the order would trade at (limit price, else LTP). */
  price: number | null;
  product: string;
  /** Broker-reported 1-qty margin from the Search Engine, when available. */
  oneQtyMargin?: number | null;
}

/** Margin required for ONE share. Prefers the broker's own number; otherwise
 *  derives it from the product's margin factor — same rule the backend uses. */
export function marginPerShare(input: MarginPerShareInput): number | null {
  const broker = Number(input.oneQtyMargin);
  if (Number.isFinite(broker) && broker > 0) return broker;
  const price = Number(input.price);
  if (!Number.isFinite(price) || !(price > 0)) return null;
  return price * marginFactor(input.product);
}

/** Whole-lot floor division helper. Returns null when the inputs can't size it. */
export function quantityFromMargin(input: {
  marginAmount: number;
  perShare: number | null;
  lotSize?: number | null;
}): number | null {
  const amount = Number(input.marginAmount);
  const per = Number(input.perShare);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isFinite(per) || per <= 0) return null;
  const lot = Number.isFinite(Number(input.lotSize)) && Number(input.lotSize) >= 1 ? Math.floor(Number(input.lotSize)) : 1;
  const rawQty = Math.floor(amount / per);
  if (rawQty < 1) return null;
  const aligned = Math.floor(rawQty / lot) * lot;
  return aligned >= lot ? aligned : null;
}

/** Margin remaining after the order. Null when inputs are unknown. */
export function marginAfterOrder(
  availableMargin: number | null,
  requiredMargin: number | null,
): number | null {
  if (availableMargin == null || requiredMargin == null) return null;
  return availableMargin - requiredMargin;
}

/** True when the ticket cannot be funded. Never blocks when unknown. */
export function hasMarginShortfall(
  availableMargin: number | null,
  requiredMargin: number | null,
): boolean {
  if (availableMargin == null || requiredMargin == null) return false;
  return requiredMargin > availableMargin;
}

/** Sum of a charges breakdown. Null when the backend gave no breakdown. */
export function chargesTotal(breakdown: Record<string, unknown> | null | undefined): number | null {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const keys = ['brokerage', 'stt', 'exchangeTransactionCharges', 'exchangeTxn', 'gst', 'sebiCharges', 'sebi', 'stampDuty'];
  let total = 0;
  let seen = 0;
  for (const k of keys) {
    const v = breakdown[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      total += v;
      seen += 1;
    }
  }
  if (typeof breakdown.total === 'number' && Number.isFinite(breakdown.total)) return breakdown.total;
  if (typeof breakdown.totalCharges === 'number' && Number.isFinite(breakdown.totalCharges)) {
    return breakdown.totalCharges;
  }
  return seen > 0 ? total : null;
}

export type TicketValidation = {
  valid: boolean;
  errors: string[];
};

/** Client-side ticket validation (inline only — the backend re-validates). */
export function validateTicket(input: {
  hasSelection: boolean;
  quantity: string;
  needsPrice: boolean;
  price: string;
  needsTrigger: boolean;
  triggerPrice: string;
}): TicketValidation {
  const errors: string[] = [];
  if (!input.hasSelection) {
    errors.push('Select an instrument.');
    return { valid: false, errors };
  }
  const qty = Number(input.quantity);
  if (!Number.isInteger(qty) || qty < 1) errors.push('Quantity must be a whole number ≥ 1.');
  if (input.needsPrice && !(Number(input.price) > 0)) errors.push('Enter a limit price.');
  if (input.needsTrigger && !(Number(input.triggerPrice) > 0)) errors.push('Enter a trigger price.');
  return { valid: errors.length === 0, errors };
}
