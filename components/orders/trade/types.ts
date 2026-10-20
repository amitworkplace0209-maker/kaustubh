'use client';

export type OrderSide = 'BUY' | 'SELL';

/** One instrument selected for trading — always derived from a REAL search
 *  result (Global Search Engine) and never synthesized in the browser. */
export interface InstrumentSelection {
  symbol: string;
  token: string;
  exchange: string;
  exchangeSegment?: string;
  tradingSymbol?: string;
  companyName?: string;
  isin?: string;
  instrumentType?: string;
  lotSize?: number;
  tickSize?: number;
  ltp?: number | null;
  prevClose?: number | null;
  change?: number | null;
  changePct?: number | null;
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
  oneQtyMargin?: number | null;
  marginStatus?: string;
  liveStatus?: string;
  tickAgeSeconds?: number | null;
  /** Canonical price source of the seed quote ('websocket' | 'broker' | 'last_close'). */
  source?: string;
  /** ISO timestamp the seed price belongs to (last trade / candle close). */
  asOf?: string;
}

export interface TicketState {
  side: OrderSide;
  product: string;
  orderType: string;
  quantity: string;
  /** Margin the user wants to commit (₹ / Coin). Drives quantity — see
   *  `quantityFromMargin`. Optional so legacy ticket constructors still type. */
  amount?: string;
  price: string;
  triggerPrice: string;
  validity: string;
  targetPrice: string;
  slPrice: string;
}

export type DecisionKind = 'PASS' | 'WARNING' | 'BLOCK' | 'EMERGENCY_BLOCK' | 'UNKNOWN';

/** Structured result of the real Risk Engine + broker margin prechecks. */
export interface PrecheckSummary {
  kind: DecisionKind;
  label: string;
  reasons: string[];
  checks: Record<string, boolean>;
  marginAvailable?: boolean | null;
  marginMessage?: string | null;
  marginRequired?: number | null;
  checkedAt: number | null;
}

export type ExecState =
  | { phase: 'idle' }
  | { phase: 'submitting'; at: string }
  /** Accepted by the engine and EXECUTED (fully or partially filled). */
  | { phase: 'filled'; status: string; orderId: string | null; filledQuantity?: number | null; averagePrice?: number | null; raw: Record<string, any> }
  /**
   * Accepted by the engine but NOT yet executed — a limit/stop order whose
   * price has not been matched by the live LTP, or any resting paper order.
   * It is NOT a success and NOT a failure: the engine is working it.
   */
  | {
      phase: 'pending';
      status: string;
      orderId: string | null;
      /** Why it is still resting, straight from the engine. */
      reason?: string | null;
      /** Engine-reported price condition it is waiting on (limit / trigger). */
      waitingFor?: number | null;
      raw: Record<string, any>;
    }
  | { phase: 'failed'; message: string; raw: Record<string, any> };

/** Normalized live quote adapted from /api/terminal/quote (adapter output). */
export interface LiveQuote {
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  change: number | null;
  changePct: number | null;
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
  /** Display label of where this price came from (never implied). */
  source: string;
  /** Canonical source id ('websocket' | 'broker' | 'last_close'). */
  sourceId?: string | null;
  /** ISO timestamp the price belongs to, when the source reports one. */
  asOf?: string | null;
  ts: number;
  stale: boolean;
  raw: Record<string, any>;
}