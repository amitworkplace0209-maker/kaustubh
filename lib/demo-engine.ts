'use client';

import { useSyncExternalStore } from 'react';
import type { AccountMode } from './settings-store';
import { calculateCharges as engineCalculateCharges } from './charge-engine.ts';

export type DemoOrder = {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  exchangeSegment: string;
  token: string;
  transactionType: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  disclosedQty: number;
  validity: string;
  status: 'COMPLETE' | 'REJECTED' | 'CANCELLED' | 'OPEN' | 'PENDING';
  averageTradedPrice: number;
  orderDate: string;
  filledQuantity: number;
  unfilledQuantity: number;
  errorMessage?: string;
  charges: DemoCharges;
};

export type DemoCharges = {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  gst: number;
  sebi: number;
  stampDuty: number;
  total: number;
};

export type DemoPosition = {
  id: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  exchangeSegment: string;
  token: string;
  product: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  netQuantity: number;
  buyQuantity: number;
  sellQuantity: number;
  averageBuyPrice: number;
  averageSellPrice: number;
  netAveragePrice: number;
  ltp: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  estimatedCharges: number;
  netPnl: number;
  marketValue: number;
};

export type DemoAccount = {
  balance: number;
  usedMargin: number;
  freeMargin: number;
  totalPnl: number;
  totalCharges: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dailyOrders: number;
  startDate: string;
};

export type DemoTransactionType = 'DEPOSIT' | 'WITHDRAWAL' | 'ORDER_CHARGE';

export type DemoTransaction = {
  id: string;
  type: DemoTransactionType;
  /** Signed amount: positive for deposits, negative for withdrawals. */
  amount: number;
  balanceAfter: number;
  timestamp: string;
  status: 'COMPLETED' | 'FAILED';
  note?: string;
};

type DemoListener = () => void;

const STORAGE_KEY = 'kaustubh_demo_engine';

/** Sensible per-transaction cap for demo funds management (â‚¹1 crore). */
export const MAX_DEMO_TRANSACTION_AMOUNT = 10_000_000;

function generateOrderId(): string {
  return 'DEMO' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/** Demo mode uses THE SAME canonical charge engine as API mode â€”
 * only the data source differs, never the math. */
function computeDemoCharges(side: string, price: number, quantity: number, product: string): DemoCharges {
  const c = engineCalculateCharges({
    side: side === 'SELL' ? 'SELL' : 'BUY',
    price,
    quantity,
    product,
    exchange: 'nse_cm',
    timestamp: new Date(),
  });
  return {
    brokerage: c.brokerage,
    stt: c.stt,
    exchangeTxn: c.exchangeTransactionCharges,
    gst: c.gst,
    sebi: c.sebiCharges,
    stampDuty: c.stampDuty,
    total: c.totalCharges,
  };
}

class DemoEngine {
  private account: DemoAccount = {
    balance: 100000,
    usedMargin: 0,
    freeMargin: 100000,
    totalPnl: 0,
    totalCharges: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    dailyOrders: 0,
    startDate: new Date().toISOString(),
  };

  private orders: DemoOrder[] = [];
  private positions: DemoPosition[] = [];
  private transactions: DemoTransaction[] = [];
  private listeners: Set<DemoListener> = new Set();

  // Immutable snapshots for useSyncExternalStore (stable references).
  accountSnapshot: DemoAccount;
  transactionsSnapshot: DemoTransaction[] = [];

  constructor() {
    this.loadFromStorage();
    this.accountSnapshot = { ...this.account };
    this.transactionsSnapshot = [...this.transactions]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  private loadFromStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.account = { ...this.account, ...(data.account || {}) };
        this.orders = data.orders || [];
        this.positions = data.positions || [];
        this.transactions = Array.isArray(data.transactions) ? data.transactions : [];
      }
    } catch { /* ignore */ }
  }

  private saveToStorage(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        account: this.account,
        orders: this.orders,
        positions: this.positions,
        transactions: this.transactions,
      }));
    } catch { /* ignore */ }
  }

  private notify(): void {
    this.accountSnapshot = { ...this.account };
    this.transactionsSnapshot = [...this.transactions]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    this.listeners.forEach((l) => l());
  }

  subscribe(listener: DemoListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAccount(): DemoAccount {
    return { ...this.account };
  }

  getOrders(): DemoOrder[] {
    return [...this.orders];
  }

  getPositions(): DemoPosition[] {
    return [...this.positions];
  }

  getTransactions(): DemoTransaction[] {
    return [...this.transactions]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Cost basis of all open demo positions. */
  getInvestedAmount(): number {
    return Math.round(
      this.positions.reduce((sum, p) => sum + Math.abs(p.netQuantity) * p.netAveragePrice, 0) * 100,
    ) / 100;
  }

  /** Funds that can be withdrawn right now (never negative). */
  getWithdrawableAmount(): number {
    return Math.max(0, this.account.balance - this.account.usedMargin);
  }

  /**
   * Add virtual funds to the demo account.
   * Throws with a user-facing message when the amount is invalid.
   */
  addFunds(amount: number): DemoTransaction {
    const amt = Number(amount);
    if (!Number.isFinite(amt)) throw new Error('Amount must be a valid number');
    if (amt <= 0) throw new Error('Amount must be greater than zero');
    if (amt > MAX_DEMO_TRANSACTION_AMOUNT) {
      throw new Error(`Maximum per transaction is â‚¹${MAX_DEMO_TRANSACTION_AMOUNT.toLocaleString('en-IN')}`);
    }
    const rounded = Math.round(amt * 100) / 100;
    this.account.balance = Math.round((this.account.balance + rounded) * 100) / 100;
    this.account.freeMargin = Math.max(0, this.account.balance - this.account.usedMargin);
    const txn: DemoTransaction = {
      id: `TXN${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
      type: 'DEPOSIT',
      amount: rounded,
      balanceAfter: this.account.balance,
      timestamp: new Date().toISOString(),
      status: 'COMPLETED',
    };
    this.transactions.unshift(txn);
    this.saveToStorage();
    this.notify();
    return txn;
  }

  /**
   * Withdraw virtual funds from the demo account.
   * Throws when the amount is invalid or exceeds the withdrawable balance.
   */
  withdrawFunds(amount: number): DemoTransaction {
    const amt = Number(amount);
    if (!Number.isFinite(amt)) throw new Error('Amount must be a valid number');
    if (amt <= 0) throw new Error('Amount must be greater than zero');
    const withdrawable = this.getWithdrawableAmount();
    if (amt > withdrawable + 1e-9) {
      throw new Error(
        `Insufficient withdrawable balance. Available: â‚¹${withdrawable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      );
    }
    if (amt > MAX_DEMO_TRANSACTION_AMOUNT) {
      throw new Error(`Maximum per transaction is â‚¹${MAX_DEMO_TRANSACTION_AMOUNT.toLocaleString('en-IN')}`);
    }
    const rounded = Math.round(amt * 100) / 100;
    this.account.balance = Math.round((this.account.balance - rounded) * 100) / 100;
    this.account.freeMargin = Math.max(0, this.account.balance - this.account.usedMargin);
    const txn: DemoTransaction = {
      id: `TXN${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`,
      type: 'WITHDRAWAL',
      amount: -rounded,
      balanceAfter: this.account.balance,
      timestamp: new Date().toISOString(),
      status: 'COMPLETED',
    };
    this.transactions.unshift(txn);
    this.saveToStorage();
    this.notify();
    return txn;
  }

  getPositionBySymbol(symbol: string): DemoPosition | undefined {
    return this.positions.find(
      (p) => p.symbol.toUpperCase() === symbol.toUpperCase() ||
        p.tradingSymbol.toUpperCase().includes(symbol.toUpperCase())
    );
  }

  async placeOrder(params: {
    symbol: string;
    tradingSymbol: string;
    exchange: string;
    exchangeSegment: string;
    token: string;
    transactionType: 'BUY' | 'SELL';
    product: string;
    orderType: string;
    quantity: number;
    price: number;
    triggerPrice: number;
    disclosedQty: number;
    validity: string;
    ltp: number;
  }): Promise<DemoOrder> {
    const {
      symbol, tradingSymbol, exchange, exchangeSegment, token,
      transactionType, product, orderType, quantity,
      price: orderPrice, triggerPrice, disclosedQty, validity, ltp,
    } = params;

    const executionPrice = orderType === 'MKT' ? ltp : orderPrice;
    const orderValue = executionPrice * quantity;
    const requiredMargin = product === 'MIS' ? orderValue * 0.2 : orderValue;

    if (requiredMargin > this.account.freeMargin) {
      const charges = computeDemoCharges(transactionType, executionPrice, quantity, product);
      const order: DemoOrder = {
        orderId: generateOrderId(),
        symbol, tradingSymbol, exchange, exchangeSegment, token,
        transactionType, product, orderType,
        quantity, price: orderPrice, triggerPrice,
        disclosedQty, validity,
        status: 'REJECTED',
        averageTradedPrice: 0,
        orderDate: new Date().toISOString(),
        filledQuantity: 0,
        unfilledQuantity: quantity,
        errorMessage: `Insufficient margin. Required: ${requiredMargin.toFixed(2)}, Available: ${this.account.freeMargin.toFixed(2)}`,
        charges,
      };
      this.orders.unshift(order);
      this.saveToStorage();
      this.notify();
      return order;
    }

    const charges = computeDemoCharges(transactionType, executionPrice, quantity, product);

    const order: DemoOrder = {
      orderId: generateOrderId(),
      symbol, tradingSymbol, exchange, exchangeSegment, token,
      transactionType, product, orderType,
      quantity, price: orderPrice, triggerPrice,
      disclosedQty, validity,
      status: 'COMPLETE',
      averageTradedPrice: executionPrice,
      orderDate: new Date().toISOString(),
      filledQuantity: quantity,
      unfilledQuantity: 0,
      charges,
    };

    this.account.usedMargin += requiredMargin;
    this.account.freeMargin = this.account.balance - this.account.usedMargin;
    this.account.totalCharges += charges.total;
    this.account.dailyOrders += 1;

    if (transactionType === 'BUY') {
      this.updatePositionBuy(symbol, tradingSymbol, exchange, exchangeSegment, token, product, quantity, executionPrice);
    } else {
      this.updatePositionSell(symbol, tradingSymbol, exchange, exchangeSegment, token, product, quantity, executionPrice, ltp);
    }

    this.orders.unshift(order);
    this.saveToStorage();
    this.notify();
    return order;
  }

  private updatePositionBuy(
    symbol: string, tradingSymbol: string, exchange: string, exchangeSegment: string,
    token: string, product: string, qty: number, price: number,
  ): void {
    const existing = this.positions.find(
      (p) => p.symbol === symbol && p.product === product
    );

    if (existing) {
      const totalBuyQty = existing.buyQuantity + qty;
      existing.averageBuyPrice =
        ((existing.averageBuyPrice * existing.buyQuantity) + (price * qty)) / totalBuyQty;
      existing.buyQuantity = totalBuyQty;
      existing.netQuantity += qty;
      existing.netAveragePrice = existing.averageBuyPrice;
      existing.ltp = price;
      this.recalculatePosition(existing);
    } else {
      this.positions.push({
        id: `${symbol}_${product}_${Date.now()}`,
        symbol, tradingSymbol, exchange, exchangeSegment, token, product,
        side: 'LONG',
        netQuantity: qty,
        buyQuantity: qty,
        sellQuantity: 0,
        averageBuyPrice: price,
        averageSellPrice: 0,
        netAveragePrice: price,
        ltp: price,
        realizedPnl: 0,
        unrealizedPnl: 0,
        grossPnl: 0,
        estimatedCharges: 0,
        netPnl: 0,
        marketValue: price * qty,
      });
    }
  }

  private updatePositionSell(
    symbol: string, tradingSymbol: string, exchange: string, exchangeSegment: string,
    token: string, product: string, qty: number, price: number, ltp: number,
  ): void {
    const existing = this.positions.find(
      (p) => p.symbol === symbol && p.product === product
    );

    if (existing && existing.netQuantity > 0) {
      const closeQty = Math.min(qty, existing.netQuantity);
      const realized = (price - existing.averageBuyPrice) * closeQty;
      const charges = computeDemoCharges('SELL', price, closeQty, product);
      existing.realizedPnl += realized - charges.total;
      existing.netQuantity -= closeQty;
      existing.sellQuantity += qty;
      existing.ltp = ltp || price;
      this.recalculatePosition(existing);

      if (existing.netQuantity === 0) {
        this.account.realizedPnl += existing.realizedPnl;
        const marginUsed = existing.averageBuyPrice * closeQty * (existing.product === 'MIS' ? 0.2 : 1);
        this.account.usedMargin = Math.max(0, this.account.usedMargin - marginUsed);
        this.account.freeMargin = this.account.balance - this.account.usedMargin;
        this.positions = this.positions.filter((p) => p.id !== existing.id);
      }
    } else {
      const totalSellQty = (existing?.sellQuantity || 0) + qty;
      const avgSell = existing
        ? ((existing.averageSellPrice * existing.sellQuantity) + (price * qty)) / totalSellQty
        : price;
      if (existing) {
        existing.sellQuantity = totalSellQty;
        existing.netQuantity -= qty;
        existing.averageSellPrice = avgSell;
        existing.side = existing.netQuantity < 0 ? 'SHORT' : existing.netQuantity > 0 ? 'LONG' : 'FLAT';
        existing.ltp = ltp || price;
        this.recalculatePosition(existing);
      } else {
        this.positions.push({
          id: `${symbol}_${product}_${Date.now()}`,
          symbol, tradingSymbol, exchange, exchangeSegment, token, product,
          side: 'SHORT',
          netQuantity: -qty,
          buyQuantity: 0,
          sellQuantity: qty,
          averageBuyPrice: 0,
          averageSellPrice: price,
          netAveragePrice: price,
          ltp: ltp || price,
          realizedPnl: 0,
          unrealizedPnl: 0,
          grossPnl: 0,
          estimatedCharges: 0,
          netPnl: 0,
          marketValue: price * qty,
        });
      }
    }
  }

  private recalculatePosition(pos: DemoPosition): void {
    pos.side = pos.netQuantity > 0 ? 'LONG' : pos.netQuantity < 0 ? 'SHORT' : 'FLAT';
    pos.marketValue = pos.ltp * Math.abs(pos.netQuantity);
    if (pos.netQuantity > 0) {
      pos.unrealizedPnl = (pos.ltp - pos.averageBuyPrice) * pos.netQuantity;
    } else if (pos.netQuantity < 0) {
      pos.unrealizedPnl = (pos.averageSellPrice - pos.ltp) * Math.abs(pos.netQuantity);
    } else {
      pos.unrealizedPnl = 0;
    }
    pos.grossPnl = pos.realizedPnl + pos.unrealizedPnl;
    pos.netPnl = pos.grossPnl - pos.estimatedCharges;
    this.account.unrealizedPnl = this.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    this.account.totalPnl = this.account.realizedPnl + this.account.unrealizedPnl;
  }

  updateLtp(symbol: string, ltp: number): void {
    this.positions.forEach((pos) => {
      if (pos.symbol === symbol || pos.tradingSymbol.toUpperCase().includes(symbol.toUpperCase())) {
        pos.ltp = ltp;
        this.recalculatePosition(pos);
      }
    });
    this.saveToStorage();
    this.notify();
  }

  reset(): void {
    this.account = {
      balance: 100000,
      usedMargin: 0,
      freeMargin: 100000,
      totalPnl: 0,
      totalCharges: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      dailyOrders: 0,
      startDate: new Date().toISOString(),
    };
    this.orders = [];
    this.positions = [];
    this.transactions = [];
    this.saveToStorage();
    this.notify();
  }

  setStartingBalance(amount: number): void {
    this.account.balance = amount;
    this.account.freeMargin = amount - this.account.usedMargin;
    this.saveToStorage();
    this.notify();
  }

  getOrderById(orderId: string): DemoOrder | undefined {
    return this.orders.find((o) => o.orderId === orderId);
  }
}

let _engine: DemoEngine | null = null;

export function getDemoEngine(): DemoEngine {
  if (!_engine) {
    _engine = new DemoEngine();
  }
  return _engine;
}

export function isDemoMode(mode: AccountMode): boolean {
  return mode === 'demo';
}

export function isApiMode(mode: AccountMode): boolean {
  return mode === 'api';
}

// ---- React bindings (hooks are top-level and unconditional) ----

function subscribeDemoEngine(listener: DemoListener): () => void {
  return getDemoEngine().subscribe(listener);
}

function getAccountSnapshot(): DemoAccount {
  return getDemoEngine().accountSnapshot;
}

function getTransactionsSnapshot(): DemoTransaction[] {
  return getDemoEngine().transactionsSnapshot;
}

function getServerAccountSnapshot(): DemoAccount {
  return {
    balance: 0, usedMargin: 0, freeMargin: 0, totalPnl: 0, totalCharges: 0,
    realizedPnl: 0, unrealizedPnl: 0, dailyOrders: 0, startDate: '',
  };
}

/** Reactive demo account snapshot. */
export function useDemoAccount(): DemoAccount {
  return useSyncExternalStore(subscribeDemoEngine, getAccountSnapshot, getServerAccountSnapshot);
}

const EMPTY_TRANSACTIONS: DemoTransaction[] = [];

/** Reactive demo transaction ledger (newest first). */
export function useDemoTransactions(): DemoTransaction[] {
  return useSyncExternalStore(
    subscribeDemoEngine,
    getTransactionsSnapshot,
    () => EMPTY_TRANSACTIONS,
  );
}
