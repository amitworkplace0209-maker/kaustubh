'use client';

// Terminal service â€” talks to the backend /api/terminal/* broker surface.
//
// Only the active terminal's data is ever read (the backend returns 409 when
// the requested terminal is not the active one, so switching is required first).
// Connect / disconnect / orders are JWT-protected; the token is held in memory
// only and never persisted. The mode SWITCH is gated by Mode Lock instead:
// passwordless when the lock is OFF, or a short-lived unlock token
// (x-mode-unlock header) when it is ON â€” which is why the switch does not carry
// an Authorization header either.

import { fromTerminalId, toTerminalId, type TerminalId, type TradingMode } from '@/lib/settings-store';
import { buildQuery } from '@/lib/api';
import { API_BASE as browserApiBase } from '@/lib/api-base';

// Same-origin in the browser: 127.0.0.1 is the DEVICE on a phone, so an
// absolute backend URL can never work there. See lib/api-base.ts.
const API_BASE = browserApiBase;

const DEFAULT_TIMEOUT_MS = 15000;

// ---- in-memory JWT (never persisted to storage) -----------------------------
let _token: string | null = null;
let _authContext = '';

export function isAuthenticated(): boolean {
  return Boolean(_token);
}

export function getAuthToken(): string | null {
  return _token;
}

function setAuthToken(token: string | null) {
  _token = token;
}

/** A UI login helper: prompt the identifiable username/password and store the
 *  issued JWT in memory only (caller surfaces the error string on failure). */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string; token?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/user/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => `${res.status} ${res.statusText}`);
      return { ok: false, error: text };
    }
    const data = await res.json();
    if (data?.token) setAuthToken(data.token);
    _authContext = username;
    return { ok: true, token: data.token };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'login request failed' };
  }
}

export function logoutAuth(): void {
  setAuthToken(null);
  _authContext = '';
}

/** In-flight hydration so any number of panels asks the app layer once. */
let _hydration: Promise<boolean> | null = null;

/**
 * Auto-hydrate the in-memory JWT from the signed app session.
 *
 * The trade page's broker calls (`connect`, `order`, `modify`, `cancel`) are
 * JWT-gated on the backend, and this module deliberately keeps the token in
 * memory only. Previously the ONLY way to obtain it was the manual sign-in card
 * (which was never mounted), so a real terminal showed "No session" / "RISK
 * LOCKED" after every reload and no order could be placed.
 *
 * `GET /api/auth/trading-token` verifies the same `kaustubh_session` cookie the
 * proxy gate uses and returns the backend operator JWT the Next layer already
 * obtains server-side. The password never reaches the browser and the token is
 * still never persisted to storage.
 *
 * Resolves `true` when a token is held; `false` when the app layer cannot mint
 * one (no operator credentials configured / backend login failed) — the caller
 * then shows the explicit sign-in card instead of pretending to be connected.
 */
export async function ensureTerminalAuth(): Promise<boolean> {
  if (_token) return true;
  if (_hydration) return _hydration;
  _hydration = (async () => {
    try {
      const res = await fetch('/api/auth/trading-token', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      const token = String((data as any)?.token ?? '');
      if (!res.ok || !token) return false;
      setAuthToken(token);
      _authContext = 'operator';
      return true;
    } catch {
      return false;
    } finally {
      _hydration = null;
    }
  })();
  return _hydration;
}

// ---- low-level fetch wrapper ------------------------------------------------
async function terminalFetch(
  path: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<any> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options ?? {};
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers,
      cache: 'no-store',
    });
    const text = await res.text().catch(() => '');
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = new Error(
        `${res.status} ${res.statusText}${body?.detail ? ` ${JSON.stringify(body.detail)}` : ''}`,
      ) as any;
      err.status = res.status;
      err.body = body;
      err.rawDetail = body?.detail ?? body?.message;
      throw err;
    }
    return body;
  } catch (err: any) {
    // A timeout we imposed aborts our own controller. Only that â€” never a
    // caller's external signal abort, raw AbortError, or a coincidental
    // network failure â€” should be reported as a friendly timeout.
    if (timedOut && (err?.name === 'AbortError' || controller.signal.aborted)) {
      throw new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- types -------------------------------------------------------------------
export type TerminalInfo = {
  id: string;
  name: string;
  active: boolean;
  enabled: boolean;
  isLoggedIn: boolean;
  status: string;
  capabilities?: {
    supportsSearch?: boolean;
    products?: string[];
    orderTypes?: string[];
    exchangeTypes?: string[];
    [key: string]: any;
  };
};

export type TerminalListResponse = {
  ok: boolean;
  active: string;
  terminals: TerminalInfo[];
};

export type TerminalState = {
  ok: boolean;
  terminal: string;
  broker: string;
  isLoggedIn: boolean;
  mode: string;
};

export type ConnectionStatus = {
  state: 'connected' | 'disconnected' | 'authenticating' | 'error';
  message?: string;
};

// ---- public API ----------------------------------------------------------------

export async function getTerminalList(): Promise<TerminalListResponse> {
  return terminalFetch('/api/terminal/list');
}

export async function getTerminalState(): Promise<TerminalState> {
  return terminalFetch('/api/terminal/state');
}

export async function switchTerminal(
  mode: TradingMode,
  options?: { modeUnlockToken?: string },
): Promise<any> {
  const headers: Record<string, string> = {};
  if (options?.modeUnlockToken) headers['x-mode-unlock'] = options.modeUnlockToken;
  return terminalFetch('/api/terminal/switch', {
    method: 'POST',
    headers,
    body: JSON.stringify({ mode: toTerminalId(mode) }),
  });
}

// ---- Mode Lock security client (/api/terminal/security) ----------------------
// Configuration endpoints (pin / lock / webauthn/register*) reuse the same
// JWT held in memory; unlock endpoints are PUBLIC by design (Mode Lock exists
// so per-browser sessions can switch modes WITHOUT the operator JWT).

export type ModeLockStatus = {
  configured: boolean;
  lockEnabled: boolean;
  methods: string[];
  webauthnRegistered: boolean;
  [key: string]: any;
};

export type UnlockResult = { ok: boolean; unlockToken?: string | null; error?: string; code?: string };

export async function getModeLockStatus(): Promise<ModeLockStatus> {
  return terminalFetch('/api/terminal/security');
}

export async function securityCall(path: string, body: Record<string, any>): Promise<any> {
  return terminalFetch(`/api/terminal/security${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function unlockWithPin(pin: string): Promise<UnlockResult> {
  try {
    const data = await terminalFetch('/api/terminal/security/unlock', {
      method: 'POST',
      body: JSON.stringify({ method: 'pin', pin }),
    });
    return { ok: data?.ok !== false, unlockToken: data?.unlockToken };
  } catch (err: any) {
    return { ok: false, code: err?.body?.detail?.code, error: err?.body?.detail?.message ?? err?.message };
  }
}

/** WebAuthn (browser biometrics) â€” register the platform authenticator. */
export async function webauthnRegisterBegin(): Promise<any> {
  return terminalFetch('/api/terminal/security/webauthn/register/begin', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
export async function webauthnRegisterComplete(payload: Record<string, any>): Promise<any> {
  return terminalFetch('/api/terminal/security/webauthn/register/complete', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
export async function webauthnAuthenticateBegin(): Promise<any> {
  return terminalFetch('/api/terminal/security/webauthn/authenticate/begin', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
export async function webauthnAuthenticateComplete(payload: Record<string, any>): Promise<any> {
  return terminalFetch('/api/terminal/security/webauthn/authenticate/complete', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function connectTerminal(terminal: TerminalId): Promise<any> {
  return terminalFetch('/api/terminal/connect', {
    method: 'POST',
    body: JSON.stringify({ terminal }),
    timeoutMs: 20000,
  });
}

export async function disconnectTerminal(): Promise<any> {
  return terminalFetch('/api/terminal/disconnect', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Shoonya OAuth entry point â€” returns the one-time authorization URL. */
export async function getShoonyaOAuthUrl(): Promise<{ url: string | null; enabled: boolean; message?: string }> {
  return terminalFetch('/api/terminal/oauth-link');
}

/** Shoonya quick-auth: submit the one-time redirect code (used exactly once). */
export async function acceptShoonyaAuthCode(code: string): Promise<any> {
  return terminalFetch('/api/terminal/oauth-code', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

// ---- active-terminal reads (backend itself enforces "active only") -----------
export async function getTerminalAccount(terminal: TerminalId): Promise<any> {
  return terminalFetch(`/api/terminal/account/${terminal}`);
}
export async function getTerminalPositions(terminal: TerminalId): Promise<any> {
  return terminalFetch(`/api/terminal/positions/${terminal}`);
}
export async function getTerminalHoldings(terminal: TerminalId): Promise<any> {
  return terminalFetch(`/api/terminal/holdings/${terminal}`);
}
export async function getTerminalOrders(terminal: TerminalId): Promise<any> {
  return terminalFetch(`/api/terminal/orders/${terminal}`);
}
export async function getTerminalTrades(terminal: TerminalId): Promise<any> {
  return terminalFetch(`/api/terminal/trades/${terminal}`);
}
export async function getTerminalAudit(terminal: TerminalId, limit = 50): Promise<any> {
  return terminalFetch(`/api/terminal/audit?terminal=${terminal}&limit=${limit}`);
}

/** Place a terminal order through the Common Trading Core (Riskâ†’Auditâ†’Adapter). */
export async function placeTerminalOrder(mode: TradingMode, order: Record<string, any>): Promise<any> {
  return terminalFetch('/api/terminal/order', {
    method: 'POST',
    body: JSON.stringify({ terminal: toTerminalId(mode), order }),
  });
}

/** Place a basket of orders; every leg runs the SAME single-order pipeline.
 *  Partial failures surface as an HTTP 400 whose detail carries per-leg results â€”
 *  err.body.detail.results is the honest per-leg picture, never swallowed. */
export async function placeTerminalBasket(mode: TradingMode, orders: Record<string, any>[]): Promise<any> {
  return terminalFetch('/api/terminal/order/basket', {
    method: 'POST',
    body: JSON.stringify({ terminal: toTerminalId(mode), orders }),
  });
}

/** Per-order book history from the adapter (order-level attempts, broker-side). */
export async function getTerminalOrderHistory(terminal: TerminalId, orderId: string): Promise<any> {
  return terminalFetch(`/api/terminal/orders/${terminal}/${encodeURIComponent(orderId)}/history`);
}

/** JWT-gated order modification through the Common Trading Core (Riskâ†’Auditâ†’Adapter). */
export async function modifyTerminalOrder(mode: TradingMode, order: Record<string, any>, orderId: string): Promise<any> {
  return terminalFetch('/api/terminal/order/modify', {
    method: 'POST',
    body: JSON.stringify({ terminal: toTerminalId(mode), order_id: orderId, order }),
  });
}

/** JWT-gated order cancellation through the Common Trading Core (Riskâ†’Auditâ†’Adapter). */
export async function cancelTerminalOrder(mode: TradingMode, orderId: string): Promise<any> {
  return terminalFetch('/api/terminal/order/cancel', {
    method: 'POST',
    body: JSON.stringify({ terminal: toTerminalId(mode), order_id: orderId }),
  });
}

// ---- real-time market reads (active terminal only) ---------------------------

export type TerminalQuoteParams = {
  token: string;
  exchange?: string;
  symbol?: string;
};

/** Real broker/dummy LTP quote for one instrument (adapter-backed, honest). */
export async function getTerminalQuote(terminal: TerminalId, params: TerminalQuoteParams): Promise<any> {
  const qs = buildQuery({
    terminal,
    token: params.token,
    exchange: params.exchange ?? 'nse_cm',
    symbol: params.symbol ?? '',
  });
  return terminalFetch(`/api/terminal/quote${qs}`);
}

export type TerminalMarginParams = {
  token: string;
  product: string;
  orderType: string;
  quantity: string;
  price: string;
  triggerPrice: string;
  transactionType: string;
  exchange?: string;
};

/** Broker-computed margin preview. Returns the honest {available:false} envelope
 *  when the terminal has no margin API or the broker cannot compute a value. */
export async function getTerminalMargin(terminal: TerminalId, params: TerminalMarginParams): Promise<any> {
  const qs = buildQuery({
    terminal,
    token: params.token,
    product: params.product,
    order_type: params.orderType,
    quantity: params.quantity,
    price: params.price,
    trigger_price: params.triggerPrice,
    transaction_type: params.transactionType,
    exchange: params.exchange ?? 'nse_cm',
  });
  return terminalFetch(`/api/terminal/margin${qs}`);
}

// ---- targets (engine-backed, terminal-scoped) --------------------------------

export type TargetEntry = {
  terminal: string;
  symbol: string;
  product: string;
  targetValue: number;
  createdAt: number;
  currentValue?: number;
  achieved?: boolean;
  remaining?: number;
  [key: string]: any;
};

export async function getTerminalTargets(terminal: TerminalId): Promise<{ data: TargetEntry[] }> {
  return terminalFetch(`/api/terminal/targets?terminal=${terminal}`);
}

/** Set a monetary target for a position (terminal-scoped engine entry). */
export async function setTerminalTarget(terminal: TerminalId, symbol: string, targetValue: number): Promise<any> {
  return terminalFetch('/api/terminal/target', {
    method: 'POST',
    body: JSON.stringify({ terminal, symbol, targetValue }),
  });
}

export async function removeTerminalTarget(terminal: TerminalId, symbol: string): Promise<any> {
  return terminalFetch(`/api/terminal/target/${encodeURIComponent(symbol)}?terminal=${terminal}`, {
    method: 'DELETE',
  });
}

// ---- Risk Engine precheck (validates WITHOUT placing the order) --------------

export async function riskPrecheck(payload: Record<string, any>): Promise<any> {
  return terminalFetch('/api/services/risk/validate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export { fromTerminalId, toTerminalId };
export type { TerminalId };
