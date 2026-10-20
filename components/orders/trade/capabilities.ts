'use client';

import type { TerminalId } from '@/lib/terminal-service';
import type { OrderSide } from '@/components/orders/trade/types';

/** Static capability truth per terminal — a faithful mirror of the backend
 *  BrokerCapabilities registry (python-service/brokers/capabilities.py). The
 *  UI never invents capabilities; anything not supported here is not offered. */
export interface TradeCapabilities {
  terminal: TerminalId;
  name: string;
  modeLabel: string;
  accountCurrency: string;
  virtualCurrency: boolean;
  supportsMarginPreview: boolean;
  products: string[];
  orderTypes: string[];
  authFlow: string;
}

export const TRADE_CAPS: Record<TerminalId, TradeCapabilities> = {
  kotak: {
    terminal: 'kotak',
    name: 'Kotak Neo',
    modeLabel: 'KOTAK NEO',
    accountCurrency: '₹',
    virtualCurrency: false,
    supportsMarginPreview: true,
    products: ['MIS', 'CNC', 'NRML', 'CASH'],
    orderTypes: ['MKT', 'L', 'SL', 'SL-M'],
    authFlow: 'credentials',
  },
  shoonya: {
    terminal: 'shoonya',
    name: 'Shoonya',
    modeLabel: 'SHOONYA',
    accountCurrency: '₹',
    virtualCurrency: false,
    supportsMarginPreview: false,
    products: ['MIS', 'CNC', 'NRML', 'CASH'],
    orderTypes: ['MKT', 'L', 'SL', 'SL-M'],
    authFlow: 'oauth',
  },
  dummy: {
    terminal: 'dummy',
    name: 'Dummy Mode',
    modeLabel: 'DUMMY',
    accountCurrency: 'Coin',
    virtualCurrency: true,
    supportsMarginPreview: false,
    products: ['MIS', 'CASH'],
    orderTypes: ['MKT', 'L', 'SL', 'SL-M'],
    authFlow: 'simulated',
  },
};

export function capsFor(terminal: TerminalId): TradeCapabilities {
  return TRADE_CAPS[terminal] ?? TRADE_CAPS.kotak;
}

/** BUY is always a fill-green action, SELL always fill-red (semantic colors). */
export const SIDE_CLASS: Record<OrderSide, string> = {
  BUY: 'bg-success text-success-foreground hover:bg-success/90',
  SELL: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

export const fmtMoney = (v: number | null | undefined, currency: string): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const n = v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return currency === 'Coin' ? `${n} Coins` : `₹${n}`;
};

export const fmtQty = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN');
};