'use client';

/**
 * Terminal capability contract — the frontend mirror of the BACKEND registry.
 *
 * The authority is `python-service/brokers/capabilities.py`
 * (`BrokerCapabilities` / `Capabilities.KOTAK|SHOONYA|DUMMY`). That file is
 * derived from each broker SDK's real surface (kotakneoapi 3.0.7,
 * NorenRestApiOAuth 0.0.41, the paper engine) and it is served live at
 * `GET /api/terminal/list` under `terminals[].capabilities`.
 *
 * This module holds:
 *   1. `TRADE_CAPS` — a STATIC mirror of that registry, used as the offline /
 *      pre-fetch fallback so the UI can render before the first fetch lands.
 *   2. `capsFromBackend()` — the mapper that turns the LIVE registry payload
 *      into the same shape. The runtime value always wins.
 *   3. The shared formatters every order surface uses.
 *
 * The old copy of this table was hand-maintained and had already drifted
 * (it carried a `modeLabel`, an `authFlow` and a `products` list that were
 * never checked against the backend). Anything the UI offers must come from
 * here, never from a hard-coded list inside a component.
 */

import type { TerminalId } from '@/lib/terminal-service';
import type { OrderSide } from '@/components/orders/trade/types';

export interface TradeCapabilities {
  terminal: TerminalId;
  name: string;
  modeLabel: string;
  /** Currency symbol the account is denominated in ('₹' or 'Coin'). */
  accountCurrency: string;
  /** True when the account is virtual (Dummy) — the UI must not print '₹'. */
  virtualCurrency: boolean;
  /** True when the broker exposes a REAL margin API (not an estimate). */
  supportsMarginPreview: boolean;
  /** True when the broker exposes a depth (bid/ask ladder) API. */
  supportsMarketDepth: boolean;
  /** True when a basket of orders can be sent. */
  supportsBasket: boolean;
  /** 'none' | 'equity' — the broker's charge model. */
  chargesModel: string;
  products: string[];
  orderTypes: string[];
  /** 'credentials' | 'oauth' | 'simulated'. */
  authFlow: string;
}

/**
 * Static mirror of `python-service/brokers/capabilities.py`.
 * Keep in sync with that file — the live registry overrides it at runtime.
 */
export const TRADE_CAPS: Record<TerminalId, TradeCapabilities> = {
  kotak: {
    terminal: 'kotak',
    name: 'Kotak Neo',
    modeLabel: 'KOTAK NEO',
    accountCurrency: '₹',
    virtualCurrency: false,
    supportsMarginPreview: true,
    supportsMarketDepth: false,
    supportsBasket: true,
    chargesModel: 'equity',
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
    supportsMarketDepth: false,
    supportsBasket: true,
    chargesModel: 'equity',
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
    supportsMarketDepth: false,
    supportsBasket: true,
    chargesModel: 'equity',
    products: ['MIS', 'CASH'],
    orderTypes: ['MKT', 'L', 'SL', 'SL-M'],
    authFlow: 'simulated',
  },
};

/** The static capability set for a terminal (never throws). */
export function capsFor(terminal: TerminalId): TradeCapabilities {
  return TRADE_CAPS[terminal] ?? TRADE_CAPS.kotak;
}

/**
 * Build the capability set from the LIVE backend registry payload
 * (`terminals[].capabilities` of `GET /api/terminal/list`).
 *
 * The backend registry is the authority; anything it does not ship keeps the
 * static mirror's value so a partial payload can never disable a control.
 */
export function capsFromBackend(
  terminal: TerminalId,
  payload: Record<string, any> | null | undefined,
): TradeCapabilities {
  const fallback = capsFor(terminal);
  if (!payload || typeof payload !== 'object') return fallback;
  const list = (value: unknown, allowed: string[]): string[] =>
    Array.isArray(value) && value.length > 0
      ? value.map((v) => String(v)).filter((v) => allowed.includes(v))
      : [];
  const products = list(payload.products, ['MIS', 'CNC', 'NRML', 'CASH', 'INTRADAY']);
  const orderTypes = list(payload.orderTypes, ['MKT', 'L', 'SL', 'SL-M']);
  return {
    terminal,
    name: typeof payload.name === 'string' && payload.name ? payload.name : fallback.name,
    modeLabel:
      typeof payload.modeLabel === 'string' && payload.modeLabel ? payload.modeLabel : fallback.modeLabel,
    accountCurrency:
      typeof payload.accountCurrency === 'string' && payload.accountCurrency
        ? payload.accountCurrency
        : fallback.accountCurrency,
    virtualCurrency:
      typeof payload.virtualCurrency === 'boolean' ? payload.virtualCurrency : fallback.virtualCurrency,
    supportsMarginPreview:
      typeof payload.supportsMarginPreview === 'boolean'
        ? payload.supportsMarginPreview
        : fallback.supportsMarginPreview,
    supportsMarketDepth:
      typeof payload.supportsMarketDepth === 'boolean'
        ? payload.supportsMarketDepth
        : fallback.supportsMarketDepth,
    supportsBasket:
      typeof payload.supportsBasket === 'boolean' ? payload.supportsBasket : fallback.supportsBasket,
    chargesModel:
      typeof payload.chargesModel === 'string' && payload.chargesModel
        ? payload.chargesModel
        : fallback.chargesModel,
    products: products.length > 0 ? products : fallback.products,
    orderTypes: orderTypes.length > 0 ? orderTypes : fallback.orderTypes,
    authFlow:
      typeof payload.authFlow === 'string' && payload.authFlow ? payload.authFlow : fallback.authFlow,
  };
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
