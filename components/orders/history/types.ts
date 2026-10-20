/** History page — normalized order-book row + bucket/filter vocabulary.
 *  Every field is derived from the adapter's real `orders` payload; unknown
 *  values stay null (never fabricated). */

export type HistoryOrderRow = {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  transactionType: 'BUY' | 'SELL' | string;
  product: string;
  orderType: string;
  quantity: number;
  price: number | null;
  triggerPrice: number | null;
  status: string;
  rawStatus: string;
  filledQuantity: number | null;
  unfilledQuantity: number | null;
  averageTradedPrice: number | null;
  orderDate: string | null;
  modifiedAt: string | null;
  errorMessage: string | null;
  source: string | null;
  raw: Record<string, any>;
};

export const HISTORY_BUCKETS = [
  { id: 'ALL', label: 'All' },
  { id: 'FILLED', label: 'Filled' },
  { id: 'OPEN', label: 'Open' },
  { id: 'PARTIALLY_FILLED', label: 'Partial' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'REJECTED', label: 'Rejected' },
] as const;

export type HistoryBucket = (typeof HISTORY_BUCKETS)[number]['id'];

export const HISTORY_SIDES = ['ALL', 'BUY', 'SELL'] as const;
export const HISTORY_PRODUCTS = ['ALL', 'MIS', 'CNC', 'NRML'] as const;

export type HistoryDateRange = 'today' | '7d' | 'all';

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : String(v ?? '');
}

function pick(row: Record<string, any>, keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]) !== '') return row[k];
  }
  return null;
}

/** Parse an order timestamp to epoch ms when recognizable; null otherwise. */
export function orderTimeMs(row: Record<string, any>): number | null {
  const raw = pick(row, ['orderDate', 'orderDateTime', 'order_time', 'placedAt', 'timeStamp', 'timestamp', 'exchTime']) as string | null;
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  const ms = num(raw);
  return ms && ms > 0 ? ms : null;
}

export function normalizeOrderRow(row: Record<string, any>): HistoryOrderRow {
  const r = row || {};
  const statusRaw = str(pick(r, ['status', 'orderStatus', 'st']) ?? '');
  const transactionType = str(pick(r, ['transactionType', 'transaction_type', 'bs', 'side', 'stkprc']) ?? '');
  const side = transactionType === 'B' ? 'BUY' : transactionType === 'S' ? 'SELL' : transactionType;
  const orderTypeRaw = str(pick(r, ['orderType', 'order_type', 'ordType']) ?? '');
  const price = num(pick(r, ['price', 'limitPrice', 'ordprc', 'orderPrice']));
  const trigger = num(pick(r, ['triggerPrice', 'trigger_price', 'trgprc', 'trigger']));
  const avg = num(pick(r, ['averageTradedPrice', 'avgTradedPrice', 'avgPrice', 'exchOrdAvgprc', 'avg']));
  const filled = num(pick(r, ['filledQuantity', 'fillQuantity', 'filledQty', 'fillQty', 'totalQty'])) ?? num(pick(r, ['executedQty', 'converted_quantity', 'cancelQty']));
  return {
    orderId: str(pick(r, ['orderId', 'order_id', 'orderid', 'nstorderno', 'orderID']) ?? '') || str(pick(r, ['id']) ?? ''),
    symbol: str(pick(r, ['symbol', 'tradingSymbol', 'scripname', 'sym']) ?? ''),
    tradingSymbol: str(pick(r, ['tradingSymbol', 'symbol', 'scripname']) ?? ''),
    exchange: str(pick(r, ['exchange', 'exch', 'exchangeSegment']) ?? ''),
    transactionType: side,
    product: str(pick(r, ['product', 'prd', 'prod']) ?? ''),
    orderType: orderTypeRaw,
    quantity: num(pick(r, ['quantity', 'qty', 'ordqty', 'disclosedQuantity'])) ?? 0,
    price,
    triggerPrice: trigger,
    status: statusRaw,
    rawStatus: statusRaw,
    filledQuantity: filled,
    unfilledQuantity: num(pick(r, ['unfilledQuantity', 'unfilledQty', 'unfilled'])),
    averageTradedPrice: avg,
    orderDate: orderTimeMs(r) ? new Date(orderTimeMs(r)!).toISOString() : null,
    modifiedAt: (() => {
      const m = pick(r, ['modifiedAt', 'modificationTime', 'previousModificationTime']) as string | null;
      if (!m) return null;
      const d = new Date(m);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    })(),
    errorMessage: (() => {
      const e = pick(r, ['errorMessage', 'errormsg', 'rejectReason', 'reason', 'Error Message']) as string | null;
      return e ? str(e) : null;
    })(),
    source: str(pick(r, ['source', 'sourceType']) ?? '') || null,
    raw: r,
  };
}

export function historyRowBucket(canonicalStatus: string): HistoryBucket {
  switch (canonicalStatus) {
    case 'FILLED':
      return 'FILLED';
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'OPEN';
  }
}

export function canCancel(canonicalStatus: string): boolean {
  return ['OPEN', 'PARTIALLY_FILLED', 'CANCEL_PENDING', ''].includes(canonicalStatus);
}

export function canModify(canonicalStatus: string): boolean {
  return ['OPEN', 'PARTIALLY_FILLED'].includes(canonicalStatus);
}

export function istDateOf(isoMs: number | null): string {
  if (isoMs == null) return 'unknown';
  const d = new Date(isoMs);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
}