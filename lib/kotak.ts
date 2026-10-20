import { API_BASE as browserApiBase } from '@/lib/api-base';
﻿/**
 * KOTAK NEO â€” real-broker trading client helpers.
 *
 * The Kotak terminal renders ONLY real data. Every number shown on a Kotak
 * page comes from the backend (Kotak Neo SDK) through the single order choke
 * point â€” never fabricated locally. This module only adds the thin Kotak
 * surface that the shared /api/trading + /api/terminal endpoints don't already
 * cover, plus honest-state helpers used by every Kotak page.
 */

// Same-origin in the browser: 127.0.0.1 is the DEVICE on a phone, so an
// absolute backend URL can never work there. See lib/api-base.ts.
const API_BASE = browserApiBase;

/** Backend terminal slug for Kotak (matches the /api/terminal/* routes). */
export const KOTAK_TERMINAL_ID = 'kotak';
export const KOTAK_LABEL = 'KOTAK NEO';
export const KOTAK_FULL_LABEL = 'KOTAK NEO TRADING TERMINAL';

/** Kotak capability truths â€” drives honest UI (never fake a capability). */
export const KOTAK_CAPABILITIES = {
  /** MKT / L / SL / SL-M â€” the Kotak SDK's order types. */
  orderTypes: ['MKT', 'L', 'SL', 'SL-M'] as const,
  products: ['MIS', 'NRML', 'CNC', 'MTF'] as const,
  /** Historical candles are NOT piped into this terminal â€” the chart uses
   *  live-tick aggregation (real LTP stream) instead. */
  supportsHistoricalData: false,
  /** Real broker-computed margin preview via SDK margin_required(). */
  supportsMarginPreview: true,
} as const;

function kotakFetch(path: string, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  return fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
      }
      return res.json();
    })
    .catch((err: any) => {
      if (timedOut) throw new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError');
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

export type MarginPreview = {
  available?: boolean;
  margin?: number;
  currency?: string;
  raw?: any;
};

/**
 * Real broker-computed margin estimate for an order intent (backend calls the
 * Kotak SDK margin_required() â†’ Risk engine). Returns `{ available: false }`
 * when the backend has no live session/margin for this scrip. Total is treated
 * as an ESTIMATE (labelled "Estimated Charges" in the UI) â€” margin can move
 * with market price.
 */
export async function getKotakMarginPreview(
  order: {
    token: string;
    exchange?: string;
    product?: string;
    orderType?: string;
    quantity?: string;
    price?: string;
    triggerPrice?: string;
    transactionType?: string;
  },
): Promise<MarginPreview> {
  const params = new URLSearchParams();
  params.set('token', order.token || '');
  params.set('exchange', order.exchange || 'nse_cm');
  params.set('product', order.product || 'MIS');
  params.set('order_type', order.orderType || 'MKT');
  params.set('quantity', order.quantity || '1');
  params.set('price', order.price || '0');
  params.set('trigger_price', order.triggerPrice || '0');
  const tx = order.transactionType || 'BUY';
  params.set('transaction_type', tx.toUpperCase());
  const data = await kotakFetch(`/api/trading/margin?${params.toString()}`);
  const total = parseNumeric(data?.data?.[0]?.TotalMargin);
  if (total == null) return { available: false, raw: data };
  return { available: true, margin: total, currency: 'â‚¹', raw: data };
}

export type AuditEntry = {
  ts?: string;
  timestamp?: string;
  terminal?: string;
  action?: string;
  detail?: string;
  source?: string;
  user?: string;
  _id?: string;
  [key: string]: any;
};

/** System audit trail for the active terminal (Audit engine â†’ Mongo). */
export function getKotakAudit(limit = 100): Promise<{ ok: boolean; terminal: string; data: AuditEntry[] }> {
  return kotakFetch(
    `/api/terminal/audit?terminal=${encodeURIComponent(KOTAK_TERMINAL_ID)}&limit=${limit}`,
  );
}

/** Coerce `"123.45"`/`123`/`"INFY"` â†’ number | null (never NaN). */
export function parseNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** True when the engine only matched on marketplace data (no live session). */
export function isConnectionError(err: any): boolean {
  const text = String(err?.message || err || '');
  return /logged|not_connected|session|connect|inactive|please connect|NOT_LOGGED_IN/i.test(text);
}

/** Normalise an order-book style status string into { tone, label }. */
export function orderStatusMeta(status?: string): { tone: 'ok' | 'warn' | 'danger' | 'muted'; label: string } {
  const s = String(status || '').toLowerCase();
  if (/(complete|executed|filled|open)/.test(s)) return { tone: 'ok', label: 'Open / Executed' };
  if (/(reject|failed|cancel|expired)/.test(s)) return { tone: 'danger', label: status || 'Failed' };
  if (/(pending|trigger|put|modif|order)/.test(s)) return { tone: 'warn', label: status || 'Pending' };
  return { tone: 'muted', label: status || 'â€”' };
}

/** POSITION-tone helper (absolute-change based, not direction of trade). */
export function pnlTone(value: number | null | undefined): 'success' | 'danger' | 'neutral' {
  const v = value ?? 0;
  if (v > 0) return 'success';
  if (v < 0) return 'danger';
  return 'neutral';
}

export const INDIAN_EXCHANGES = ['nse_cm', 'bse_cm', 'nse_fo', 'bse_fo', 'mcx_fo'] as const;

export function readableExchange(exchange?: string): string {
  const map: Record<string, string> = {
    nse_cm: 'NSE', bse_cm: 'BSE', nse_fo: 'NSE F&O', bse_fo: 'BSE F&O', mcx_fo: 'MCX',
  };
  return exchange && map[exchange] ? map[exchange] : exchange || 'â€”';
}