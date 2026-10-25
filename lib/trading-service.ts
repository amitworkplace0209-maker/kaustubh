'use client';

import { getSettingsStore } from './settings-store';
import {
  placeOrder as apiPlaceOrder,
  getPositions as apiGetPositions,
  squareOffPosition as apiSquareOffPosition,
  getOrderBook as apiGetOrderBook,
  getOrderHistory as apiGetOrderHistory,
  getFunds as apiGetFunds,
  placeDemoOrder,
  getDemoPositions,
  getDemoOrders,
  getDemoAccount,
  getDemoTransactions,
  squareOffDemoPosition,
  addDemoFunds,
  withdrawDemoFunds,
  updateDemoLtp,
} from '@/lib/api';

/*
 * Mode-routed trading abstraction.
 *
 * KOTAK NEO  -> KotakNeoTradingService (Python /api/trading -> Kotak SDK)
 * DUMMY MODE -> DummyTradingService    (Python /api/demo -> server-side
 *                                       Dummy Trading Engine, MongoDB)
 *
 * Both implementations expose the SAME response shapes so terminal consumers
 * (order entry, positions, history, trigger engine) never branch on mode.
 * The routing boundary lives here and in the Python API layer — never in the
 * UI — so state can never leak between the two accounts.
 */

export type PlaceOrderParams = {
  exchange: string;
  symbol: string;
  token: string;
  tradingSymbol?: string;
  exchangeSegment?: string;
  transaction_type: string;
  product: string;
  order_type: string;
  quantity: string;
  price: string;
  trigger_price: string;
  disclosed_quantity: string;
  validity: string;
  amo?: string;
  ltp?: number;
  /** Margin the user committed (₹ / Coin). When > 0 the engine sizes the
   *  order itself: qty = whole lots of amount / margin-per-share. */
  amount?: number;
  lotSize?: number;
  marginPerShare?: number;
};

export type PositionResult = {
  id?: string;
  symbol?: string;
  tradingSymbol?: string;
  exchange?: string;
  exchangeSegment?: string;
  product?: string;
  side?: string;
  netQuantity?: number;
  buyQuantity?: number;
  sellQuantity?: number;
  averageBuyPrice?: number;
  averageSellPrice?: number;
  netAveragePrice?: number;
  ltp?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  grossPnl?: number;
  estimatedCharges?: number;
  netPnl?: number;
  isDemo?: boolean;
  [key: string]: any;
};

export type OrderResult = {
  data?: {
    n_ord_no?: string;
    order_id?: string;
    stat?: string;
    remarks?: string;
  };
  stat?: string;
  isDemo?: boolean;
  [key: string]: any;
};

export type FundsResult = {
  availableMargin: number;
  usedMargin: number;
  totalBalance: number;
  isDemo: boolean;
};

export interface TradingServiceAdapter {
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;
  getPositions(): Promise<any>;
  squareOffPosition(params: any): Promise<any>;
  getFunds(): Promise<FundsResult>;
  getOrderHistory(): Promise<any>;
  getOrderBook(): Promise<any>;
}

/* ---------------------------------------------------------------------- */
/* KOTAK NEO — real broker via the Python /api/trading layer.              */
/* ---------------------------------------------------------------------- */

export const KotakNeoTradingService: TradingServiceAdapter = {
  placeOrder(params) {
    return apiPlaceOrder({
      exchange: params.exchange,
      symbol: params.symbol,
      token: params.token,
      transaction_type: params.transaction_type,
      product: params.product,
      order_type: params.order_type,
      quantity: params.quantity,
      price: params.price,
      trigger_price: params.trigger_price,
      disclosed_quantity: params.disclosed_quantity,
      validity: params.validity,
      amo: params.amo,
    });
  },

  getPositions() {
    return apiGetPositions();
  },

  squareOffPosition(params) {
    return apiSquareOffPosition(params);
  },

  async getFunds(): Promise<FundsResult> {
    try {
      const result = await apiGetFunds();
      const rms = result?.data?.limitObject?.RMS || {};
      return {
        availableMargin: parseFloat(rms.available_margin) || parseFloat(rms.cash_margin_available) || 0,
        usedMargin: parseFloat(rms.utilised_debit) || 0,
        totalBalance: parseFloat(rms.fund_limit) || 0,
        isDemo: false,
      };
    } catch {
      return { availableMargin: 0, usedMargin: 0, totalBalance: 0, isDemo: false };
    }
  },

  getOrderHistory() {
    return apiGetOrderHistory('orders', '');
  },

  getOrderBook() {
    return apiGetOrderBook();
  },
};

/* ---------------------------------------------------------------------- */
/* DUMMY MODE — server-side Dummy Trading Engine (/api/demo, MongoDB).     */
/* Server responses are mapped to the same shapes the Kotak service emits. */
/* ---------------------------------------------------------------------- */

export function normalizeDemoPositions(rows: Array<Record<string, any>>): PositionResult[] {
  return (rows || []).map((p, idx) => {
    const sym = String(p.symbol || '');
    const trdSym = String(p.tradingSymbol || sym);
    const netQty = Number(p.netQuantity) || 0;
    const avgBuy = Number(p.averageBuyPrice) || 0;
    const avgSell = Number(p.averageSellPrice) || 0;
    const avg = netQty > 0 ? avgBuy : netQty < 0 ? avgSell : avgBuy;
    const ltp = Number(p.ltp) || 0;
    const buyQty = Number(p.buyQuantity) || 0;
    const sellQty = Number(p.sellQuantity) || 0;
    const realised = Number(p.realizedPnl) || 0;
    const unrealised = Number(p.unrealizedPnl) || 0;
    const gross = Number(p.grossPnl) || realised + unrealised;
    const charges = Number(p.estimatedCharges) || 0;
    const token = String(p.token || '');
    return {
      id: p.id,
      symbol: sym,
      tradingSymbol: trdSym,
      exchange: p.exchange,
      exchangeSegment: p.exchangeSegment || p.exchange,
      product: p.product,
      side: netQty > 0 ? 'LONG' : netQty < 0 ? 'SHORT' : 'FLAT',
      netQuantity: netQty,
      buyQuantity: buyQty,
      sellQuantity: sellQty,
      netAveragePrice: avg,
      ltp,
      realizedPnl: realised,
      unrealizedPnl: unrealised,
      grossPnl: gross,
      estimatedCharges: charges,
      netPnl: Number(p.netPnl) || gross - charges,
      isDemo: true,
      // Dash-case aliases consumed by position tables/normalizers.
      sym,
      sym_clean: sym,
      trdSym,
      trdSym_clean: trdSym,
      exSeg: p.exchangeSegment || p.exchange,
      exSeg_clean: p.exchangeSegment || p.exchange,
      exchange_segment: p.exchangeSegment || p.exchange,
      prod: p.product,
      prod_clean: p.product,
      net_qty: netQty,
      qty: netQty,
      buy_qty: buyQty,
      sell_qty: sellQty,
      buy_avg: avgBuy,
      sell_avg: avgSell,
      net_average_price: avg,
      avg_price: avg,
      average_price: avg,
      buy_value: avgBuy * buyQty,
      sell_value: avgSell * sellQty,
      realised,
      unrealised,
      gross_pnl: gross,
      net_pnl: Number(p.netPnl) || gross - charges,
      estimated_charges: charges,
      market_value: ltp * Math.abs(netQty),
      position_type: netQty > 0 ? 'BUY' : netQty < 0 ? 'SELL' : 'FLAT',
      position_status: netQty ? 'OPEN' : 'CLOSED',
      company_name: String(p.companyName || ''),
      tok: token,
      token,
      instrument_token: token,
      instrumentToken: token,
      hsUpTm: '',
      last_known_ltp: ltp > 0 ? ltp : null,
      position_index: idx,
      raw: p,
    };
  });
}

export function normalizeDemoOrders(rows: Array<Record<string, any>>): any[] {
  return (rows || []).map((o) => ({
    n_ord_no: o.orderId,
    order_id: o.orderId,
    trading_symbol: o.tradingSymbol,
    symbol: o.symbol,
    transaction_type: o.transactionType,
    product: o.product,
    order_type: o.orderType,
    quantity: String(o.quantity ?? ''),
    price: String(o.price ?? ''),
    trigger_price: String(o.triggerPrice ?? ''),
    status: o.status,
    average_traded_price: String(o.averageTradedPrice ?? ''),
    order_date: o.orderDate,
    filled_quantity: String(o.filledQuantity ?? ''),
    unfilled_quantity: String(o.unfilledQuantity ?? ''),
    charges: o.charges ?? null,
    isDemo: true,
  }));
}

export const DummyTradingService: TradingServiceAdapter & {
  addFunds(amount: number): Promise<any>;
  withdrawFunds(amount: number): Promise<any>;
  getTransactions(): Promise<any>;
  updateLtp(updates: { symbol: string; ltp: number }[]): Promise<any>;
} = {
  placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    return placeDemoOrder({
      symbol: params.symbol,
      tradingSymbol: params.tradingSymbol || params.symbol,
      exchange: params.exchange,
      exchangeSegment: params.exchangeSegment || params.exchange,
      token: params.token,
      transactionType: params.transaction_type,
      product: params.product,
      orderType: params.order_type,
      quantity: parseInt(params.quantity) || 0,
      price: parseFloat(params.price) || 0,
      triggerPrice: parseFloat(params.trigger_price) || 0,
      disclosedQty: parseInt(params.disclosed_quantity) || 0,
      validity: params.validity,
      ltp: params.ltp || 0,
      amount: params.amount || 0,
      lotSize: params.lotSize || 0,
      marginPerShare: params.marginPerShare || 0,
    });
  },

  async getPositions() {
    const res = await getDemoPositions();
    return {
      data: normalizeDemoPositions(Array.isArray(res?.data) ? res.data : []),
      stat: res?.stat ?? 'Ok',
      isDemo: true,
    };
  },

  squareOffPosition(params) {
    return squareOffDemoPosition(params.symbol, params.product || 'MIS');
  },

  async getFunds(): Promise<FundsResult> {
    const res = await getDemoAccount();
    const account = res?.account || {};
    return {
      availableMargin: Number(account.freeMargin) || 0,
      usedMargin: Number(account.usedMargin) || 0,
      totalBalance: Number(account.balance) || 0,
      isDemo: true,
    };
  },

  async getOrderHistory() {
    const res = await getDemoOrders();
    return {
      data: normalizeDemoOrders(Array.isArray(res?.data) ? res.data : []),
      stat: 'Ok',
      isDemo: true,
    };
  },

  async getOrderBook() {
    const res = await getDemoOrders();
    const open = (Array.isArray(res?.data) ? res.data : []).filter(
      (o: Record<string, any>) => o.status === 'OPEN' || o.status === 'PENDING'
    );
    return {
      data: normalizeDemoOrders(open),
      stat: 'Ok',
      isDemo: true,
    };
  },

  addFunds(amount: number) {
    return addDemoFunds(amount);
  },

  withdrawFunds(amount: number) {
    return withdrawDemoFunds(amount);
  },

  getTransactions() {
    return getDemoTransactions();
  },

  updateLtp(updates: { symbol: string; ltp: number }[]) {
    return updateDemoLtp(updates);
  },
};

/* ---------------------------------------------------------------------- */
/* Router — the only surface the UI imports.                               */
/* ---------------------------------------------------------------------- */

function getAdapter(): TradingServiceAdapter {
  // Route on the CANONICAL mode, never the legacy `accountMode` mirror — a
  // stale mirror sent Dummy funds/orders to the Kotak adapter.
  return getSettingsStore().getTradingMode() === 'dummy' ? DummyTradingService : KotakNeoTradingService;
}

export const TradingService: TradingServiceAdapter & {
  isDummy(): boolean;
  addFunds(amount: number): Promise<any>;
  withdrawFunds(amount: number): Promise<any>;
  getTransactions(): Promise<any>;
  updateLtp(updates: { symbol: string; ltp: number }[]): Promise<any>;
} = {
  isDummy(): boolean {
    return getSettingsStore().getTradingMode() === 'dummy';
  },

  placeOrder(params: PlaceOrderParams) {
    return getAdapter().placeOrder(params);
  },

  getPositions() {
    return getAdapter().getPositions();
  },

  squareOffPosition(params: any) {
    return getAdapter().squareOffPosition(params);
  },

  getFunds() {
    return getAdapter().getFunds();
  },

  getOrderHistory() {
    return getAdapter().getOrderHistory();
  },

  getOrderBook() {
    return getAdapter().getOrderBook();
  },

  // Dummy-only fund management (safe to expose globally; other mode errors.)
  addFunds(amount: number) {
    return DummyTradingService.addFunds(amount);
  },

  withdrawFunds(amount: number) {
    return DummyTradingService.withdrawFunds(amount);
  },

  getTransactions() {
    return DummyTradingService.getTransactions();
  },

  updateLtp(updates: { symbol: string; ltp: number }[]) {
    return DummyTradingService.updateLtp(updates);
  },
};