import { getISTTimestamp, formatISTTime, formatISTDate, formatISTDateTime, IST_TIMEZONE } from './ist';
import { dedupFetch } from './request-dedup';
import { API_BASE as browserApiBase } from '@/lib/api-base';

// Same-origin in the browser: 127.0.0.1 is the DEVICE on a phone, so an
// absolute backend URL can never work there. See lib/api-base.ts.
const API_BASE = browserApiBase;

export type DummyAccount = {
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

export type DummyPosition = {
  symbol: string;
  tradingSymbol: string;
  token: string;
  exchange: string;
  product: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  netQuantity: number;
  buyQuantity: number;
  sellQuantity: number;
  averageBuyPrice: number;
  averageSellPrice: number;
  ltp: number;
  realizedPnl: number;
  unrealizedPnl: number;
  grossPnl: number;
  estimatedCharges: number;
  netPnl: number;
  marketValue: number;
};

export type DummyOrder = {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  transactionType: string;
  product: string;
  orderType: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  status: string;
  averageTradedPrice: number;
  orderDate: string;
  filledQuantity: number;
  unfilledQuantity: number;
  errorMessage?: string | null;
  modifiedAt?: string | null;
  source?: string;
};

export type BasketLegModel = {
  symbol: string;
  tradingSymbol?: string;
  exchange?: string;
  exchangeSegment?: string;
  token?: string;
  transactionType: 'BUY' | 'SELL';
  product?: string;
  orderType?: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
};

export type DummyBasket = {
  id: string;
  name: string;
  legs: BasketLegModel[];
  policy: { mode: 'ALL' | 'MIN' | 'EXACT'; minimum: number };
  expirySeconds: number;
  instructions: string;
  createdAt: string;
  audit: Array<Record<string, any>>;
};

export type DummyAlert = {
  id: string;
  symbol: string;
  condition: 'ABOVE' | 'BELOW';
  price: number;
  cooldownSec: number;
  status: string;
  note: string;
  lastTriggeredAt: string | null;
};

export type DummyTarget = {
  id: string;
  symbol: string;
  targetType: 'PERCENT' | 'FIXED' | 'AMOUNT';
  value: number;
  direction: 'PROFIT' | 'LOSS';
  autoExecute: boolean;
  status: string;
  refPrice: number | null;
  triggeredAt: string | null;
  executedAt: string | null;
};

export type DummyNotification = {
  id: string;
  category: string;
  title: string;
  message: string;
  meta: Record<string, any>;
  read: boolean;
  ts: string;
};

export type MarketSnapshot = {
  market_status: 'OPEN' | 'CLOSED';
  market_session: string;
  market_date: string;
  day_class: string;
  trading_day: boolean;
  closure_reason: string | null;
  next_market_open: string | null;
  next_market_close: string | null;
  next_trading_day?: string | null;
  now_ist: string;
  timezone: string;
  tradingDate?: string;
};

export type DummySession = {
  sessionId: string;
  trading_date: string;
  terminal: string;
  status: 'OPEN' | 'PRE_OPEN' | 'CLOSED';
  started_at: string | null;
  closed_at: string | null;
  starting_capital: number;
  available_capital: number;
  used_capital: number;
  reserved_margin: number;
  realized_pnl: number;
  unrealized_pnl: number;
  today_pnl: number;
  charges: number;
  turnover: number;
  order_count: number;
  trade_count: number;
  position_count: number;
  basket_count: number;
  pending_order_count?: number;
  unread_notifications?: number;
  updatedAt?: string;
};

export type DummyState = {
  ok: boolean;
  terminal: string;
  account: DummyAccount;
  positions: DummyPosition[];
  orders: DummyOrder[];
  risk: {
    balance: number;
    usedMargin: number;
    freeMargin: number;
    marginUtilizationPct: number;
    exposure: number;
    openPositions: number;
    todayOrders: number;
    activeAlerts: number;
    pendingTargets: number;
  };
  market: MarketSnapshot;
  unreadNotifications: number;
  targets: DummyTarget[];
  alerts: DummyAlert[];
  session: DummySession;
  nowUtc: string;
};

export type DummyPrefs = {
  autoRefreshMs: number;
  defaultProduct: string;
  defaultOrderType: string;
  defaultBasketPolicy: string;
  confirmBasketExecute: boolean;
  alertCooldownSec: number;
  autoSquareOffOnTarget: boolean;
  retentionDays: number;
  slippageBps: number;
  maxDailyOrders: number;
  maxOrderValue: number;
  notificationDelivery: {
    inApp: boolean;
    popup: boolean;
    sound: boolean;
    push: boolean;
  };
};

export type NotificationDeliveryPrefs = Partial<DummyPrefs['notificationDelivery']>;

export type OrderPreview = {
  symbol: string;
  side: 'BUY' | 'SELL';
  product: string;
  orderType: string;
  quantity: number;
  estimatedPrice: number;
  baseValue: number;
  charges: {
    brokerage: number;
    stt: number;
    exchangeTxn: number;
    gst: number;
    sebi: number;
    stampDuty: number;
    total: number;
  };
  marginFactor: number;
  marginRequired: number;
  freeMargin: number;
  remainingAfterBuy: number;
  sufficient: boolean;
};

export type ClosedPosition = {
  id: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  exchangeSegment: string;
  token: string;
  product: string;
  side: string;
  quantity: number;
  averagePrice: number;
  exitPrice: number;
  realizedPnl: number;
  charges: number;
  netPnl: number;
  reason: string;
  closedAt: string;
  tradingDate: string;
};

export type BracketedPositions = {
  ok: boolean;
  /** Trading date partition (YYYY-MM-DD, IST 08:30 cutoff) — the page is day-scoped to this date. */
  tradingDate?: string;
  open: DummyPosition[];
  closed: ClosedPosition[];
};

export type WatchlistSymbol = {
  symbol: string;
  tradingSymbol?: string;
  exchange?: string;
  exchangeSegment?: string;
  token?: string;
  addedAt?: string;
};

export type Watchlist = {
  id: string;
  name: string;
  createdAt: string;
  symbols: WatchlistSymbol[];
};

export type WatchlistsPayload = {
  ok: boolean;
  activeId: string;
  items: Watchlist[];
};

export type CalendarEvent = {
  id: string;
  date: string;
  category: 'TRADING' | 'MARKET' | 'PERSONAL';
  title: string;
  note: string;
  pinned: boolean;
  reminderMinutes: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: string;
  ts: string;
  category: string;
  action: string;
  meta: Record<string, any>;
};

export type TerminalComparison = {
  ok: boolean;
  kotak: TerminalComparisonTerminal;
  shoonya: TerminalComparisonTerminal;
  dummy: TerminalComparisonTerminal;
  combined: TerminalComparisonCombined;
};

export type TerminalComparisonTerminal = {
  connected: boolean;
  available?: boolean;
  funds?: { balance?: number; usedMargin?: number; availableMargin?: number };
  balance?: number;
  usedMargin?: number;
  freeMargin?: number;
  availableMargin?: number;
  invested?: number;
  currentValue?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  totalCharges?: number;
  exposure?: number;
  positionCount?: number;
  openPositions?: number;
  dailyOrders?: number;
  orders?: {
    total: number;
    open: number;
    pending: number;
    completed: number;
    cancelled: number;
    rejected: number;
    partial: number;
  };
};

export type TerminalComparisonCombined = {
  connected: boolean;
  balance?: number;
  usedMargin?: number;
  availableMargin?: number;
  invested?: number;
  currentValue?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  exposure?: number;
  positionCount?: number;
  orders?: {
    total: number;
    open: number;
    pending: number;
    completed: number;
    cancelled: number;
    rejected: number;
    partial: number;
  };
};

export type SuggestionCheck = {
  name: string;
  label: string;
  passed: boolean;
  message: string;
};

export type DummySuggestion = {
  id: string;
  source: string;
  model: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
  quantity: number;
  entry: number;
  target: number;
  stopLoss: number;
  expectedValue: number;
  risk: number;
  type: 'NORMAL' | 'BASKET';
  legs: BasketLegModel[];
  reason: string;
  product: string;
  orderType: string;
  expiry: string | null;
  status: string;
  pipeline: string[];
  checks: SuggestionCheck[];
  orderId: string | null;
  duplicateOf: string | null;
  error: string | null;
  rejectReason: string | null;
  processedAt: string | null;
  createdAt: string;
  result?: Record<string, any>;
};

export const SUGGESTION_PIPELINE = [
  'RECEIVED',
  'VALIDATED',
  'DUPLICATE_CHECK',
  'EXPIRY_CHECK',
  'RISK_CHECK',
  'ORDER_ENGINE',
  'DUMMY_BROKER',
  'RESULT',
  'NOTIFICATION',
  'AUDIT',
] as const;

export const SUGGESTION_STATUSES = [
  'RECEIVED',
  'VALIDATING',
  'VALIDATED',
  'REJECTED',
  'DUPLICATE',
  'EXPIRED',
  'RISK_REJECTED',
  'EXECUTING',
  'EXECUTED',
  'FAILED',
  'CANCELLED',
] as const;

export function suggestionStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const s = (status || '').toUpperCase();
  if (s === 'EXECUTED') return 'success';
  if (s === 'RECEIVED' || s === 'VALIDATED') return 'info';
  if (s === 'VALIDATING' || s === 'EXECUTING') return 'warning';
  if (s === 'REJECTED' || s === 'FAILED' || s === 'RISK_REJECTED' || s === 'DUPLICATE' || s === 'EXPIRED') return 'danger';
  if (s === 'CANCELLED') return 'neutral';
  return 'info';
}

export function suggestionOutcome(s: DummySuggestion): { label: string; tone: 'success' | 'danger' | 'warning' } {
  const status = (s.status || '').toUpperCase();
  if (status === 'EXECUTED') return { label: `Executed Â· ${s.orderId ?? 'â€”'}`, tone: 'success' };
  if (status === 'CANCELLED') return { label: `Cancelled Â· ${s.rejectReason ?? ''}`, tone: 'warning' };
  if (status === 'RISK_REJECTED') return { label: `Risk rejected Â· ${s.error ?? s.rejectReason ?? ''}`, tone: 'danger' };
  if (status === 'REJECTED') return { label: `Rejected Â· ${s.error ?? s.rejectReason ?? ''}`, tone: 'danger' };
  if (status === 'DUPLICATE') return { label: `Duplicate of ${s.duplicateOf ?? ''}`, tone: 'danger' };
  if (status === 'EXPIRED') return { label: `Expired Â· ${s.error ?? ''}`, tone: 'danger' };
  if (status === 'FAILED') return { label: `Failed Â· ${s.error ?? ''}`, tone: 'danger' };
  return { label: status, tone: 'warning' };
}

async function dapiOnce<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail: unknown = null;
      try {
        detail = await res.json();
      } catch {
        detail = res.statusText;
      }
      throw new Error(typeof detail === 'object' && detail && 'detail' in (detail as any)
        ? JSON.stringify((detail as any).detail)
        : `HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (timedOut) throw new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function dapi<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  // GET-only in-flight dedupe: React dev StrictMode mounts effects twice, and
  // several panels request the same Dummy read during one route transition.
  // Mutations (POST/DELETE/PATCH) are NEVER shared — each call must reach the
  // backend exactly once.
  const method = (init?.method || 'GET').toUpperCase();
  if (method === 'GET' && !init?.body) {
    return dedupFetch(`dapi:${path}`, () => dapiOnce<T>(path, init, timeoutMs));
  }
  return dapiOnce<T>(path, init, timeoutMs);
}

export const getDummyState = (): Promise<DummyState> => dapi('/api/dummy/state');
export const getDummySession = () =>
  dapi<{ ok: boolean; session: DummySession }>('/api/dummy/session');
export const resetDummySession = (startingCapital?: number, force = false) =>
  dapi<{ ok: boolean; session: DummySession }>(
    `/api/dummy/session/reset?startingCapital=${startingCapital ?? ''}&force=${force}`,
    { method: 'POST', body: JSON.stringify({}) },
  );
export const getDummyPortfolio = () => dapi<any>('/api/dummy/portfolio');
export const getDummyHoldings = () => dapi<any>('/api/dummy/holdings');
export const getDummyRisk = () => dapi<any>('/api/dummy/risk');
export const getDummyHistory = (days = 7) => dapi<any>(`/api/dummy/history?days=${days}`);
export const getDummyCalendar = () => dapi<any>('/api/dummy/calendar');
export const getDummyMarketSession = () => dapi<any>('/api/dummy/market-session');
export const runDummyRetention = (cutoffDays = 7) =>
  dapi<any>(`/api/dummy/maintenance/retention?cutoffDays=${cutoffDays}`, { method: 'POST' });

export const getDummyBaskets = () => dapi<{ ok: boolean; data: DummyBasket[] }>('/api/dummy/baskets');
export const createDummyBasket = (data: Record<string, any>) =>
  dapi<any>('/api/dummy/baskets', { method: 'POST', body: JSON.stringify(data) });
export const deleteDummyBasket = (id: string) =>
  dapi<any>(`/api/dummy/baskets/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const executeDummyBasket = (data: Record<string, any>) =>
  dapi<any>('/api/dummy/baskets/execute', { method: 'POST', body: JSON.stringify(data) });

export const getDummyAlerts = () => dapi<{ ok: boolean; data: DummyAlert[] }>('/api/dummy/alerts');
export const createDummyAlert = (data: Record<string, any>) =>
  dapi<any>('/api/dummy/alerts', { method: 'POST', body: JSON.stringify(data) });
export const deleteDummyAlert = (id: string) =>
  dapi<any>(`/api/dummy/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getDummyTargets = () => dapi<{ ok: boolean; data: DummyTarget[] }>('/api/dummy/targets');
export const createDummyTarget = (data: Record<string, any>) =>
  dapi<any>('/api/dummy/targets', { method: 'POST', body: JSON.stringify(data) });
export const deleteDummyTarget = (id: string) =>
  dapi<any>(`/api/dummy/targets/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getDummyNotifications = (category = '', limit = 100) =>
  dapi<{ ok: boolean; data: DummyNotification[]; unread: number; total: number }>(
    `/api/dummy/notifications?category=${encodeURIComponent(category)}&limit=${limit}`,
  );
export const readDummyNotification = (id: string) =>
  dapi<any>('/api/dummy/notifications/read', { method: 'POST', body: JSON.stringify({ id }) });
export const readAllDummyNotifications = () =>
  dapi<any>('/api/dummy/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
export const deleteDummyNotification = (id: string) =>
  dapi<any>(`/api/dummy/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const clearDummyNotifications = () =>
  dapi<any>('/api/dummy/notifications', { method: 'DELETE' });

export const getDummyPrefs = () => dapi<{ ok: boolean; prefs: DummyPrefs }>('/api/dummy/prefs');
export const updateDummyPrefs = (patch: Partial<DummyPrefs>) =>
  dapi<{ ok: boolean; prefs: DummyPrefs }>('/api/dummy/prefs', { method: 'POST', body: JSON.stringify(patch) });

export const getDummyOrderPreview = (data: Record<string, any>): Promise<OrderPreview> =>
  dapi<OrderPreview>('/api/dummy/preview', { method: 'POST', body: JSON.stringify(data) });

export const getDummyPositions = (): Promise<BracketedPositions> => dapi('/api/dummy/positions');
export const getDummyReports = (range: 'daily' | 'weekly' | 'monthly' = 'daily', limit = 60) =>
  dapi<{ ok: boolean; range: string; rows: any[]; tradingDate: string }>(
    `/api/dummy/reports?range=${encodeURIComponent(range)}&limit=${limit}`,
  );
export const getDummyComparison = (): Promise<TerminalComparison> => dapi('/api/dummy/comparison');
export const getDummyAudit = (category = '', limit = 100) =>
  dapi<{ ok: boolean; data: AuditEvent[] }>(`/api/dummy/audit?category=${encodeURIComponent(category)}&limit=${limit}`);

export const getDummyWatchlists = () => dapi<WatchlistsPayload>('/api/dummy/watchlists');
export const createDummyWatchlist = (name: string, symbols: WatchlistSymbol[] = []) =>
  dapi<any>('/api/dummy/watchlists', { method: 'POST', body: JSON.stringify({ name, symbols }) });
export const deleteDummyWatchlist = (id: string) =>
  dapi<any>(`/api/dummy/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const setActiveDummyWatchlist = (id: string) =>
  dapi<any>('/api/dummy/watchlists/active', { method: 'POST', body: JSON.stringify({ id }) });
export const addDummyWatchlistSymbol = (id: string, item: WatchlistSymbol) =>
  dapi<any>(`/api/dummy/watchlists/${encodeURIComponent(id)}/symbols`, {
    method: 'POST',
    body: JSON.stringify({ symbol: item }),
  });
export const removeDummyWatchlistSymbol = (id: string, symbol: string) =>
  dapi<any>(`/api/dummy/watchlists/${encodeURIComponent(id)}/symbols/remove`, {
    method: 'POST',
    body: JSON.stringify({ symbol }),
  });

export const getDummyCalendarEvents = (dateFrom = '', dateTo = '') =>
  dapi<{ ok: boolean; data: CalendarEvent[] }>(
    `/api/dummy/calendar-events?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`,
  );
export const createDummyCalendarEvent = (data: Record<string, any>) =>
  dapi<{ ok: boolean; event: CalendarEvent }>('/api/dummy/calendar-events', {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const updateDummyCalendarEvent = (id: string, patch: Record<string, any>) =>
  dapi<{ ok: boolean; event: CalendarEvent }>(`/api/dummy/calendar-events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
export const deleteDummyCalendarEvent = (id: string) =>
  dapi<any>(`/api/dummy/calendar-events/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const modifyDummyOrder = (data: Record<string, any>) =>
  dapi<any>('/api/dummy/order/modify', { method: 'POST', body: JSON.stringify(data) });

export const getDummySuggestions = (status = '', limit = 100) =>
  dapi<{ ok: boolean; data: DummySuggestion[]; pipeline: string[]; statuses: string[] }>(
    `/api/dummy/suggestions?status=${encodeURIComponent(status)}&limit=${limit}`,
  );
export const receiveDummySuggestion = (data: Record<string, any>) =>
  dapi<{ ok: boolean; suggestion: DummySuggestion }>('/api/dummy/suggestions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
export const processDummySuggestion = (id: string, ltpMap: Record<string, number> = {}) =>
  dapi<{ ok: boolean; suggestion: DummySuggestion }>(`/api/dummy/suggestions/${encodeURIComponent(id)}/process`, {
    method: 'POST',
    body: JSON.stringify({ ltpMap }),
  });
export const rejectDummySuggestion = (id: string, reason = '') =>
  dapi<{ ok: boolean; suggestion: DummySuggestion }>(`/api/dummy/suggestions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
export const deleteDummySuggestion = (id: string) =>
  dapi<any>(`/api/dummy/suggestions/${encodeURIComponent(id)}`, { method: 'DELETE' });

export function equityLabel(v: number | null | undefined): string {
  return `${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Coins`;
}

export function sessionLabel(session: string): string {
  switch (session) {
    case 'PRE_OPEN':
      return 'PRE-OPEN';
    case 'POST_CLOSE':
      return 'POST-CLOSE';
    case 'CLOSED':
      return 'CLOSED';
    case 'OPEN':
      return 'MARKET OPEN';
    default:
      return session;
  }
}

export function orderStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const s = (status || '').toUpperCase();
  if (s === 'COMPLETE' || s === 'FILLED' || s === 'EXECUTED') return 'success';
  if (s === 'OPEN' || s === 'PENDING' || s === 'TRIGGER_PENDING') return 'warning';
  if (s === 'REJECTED') return 'danger';
  if (s === 'CANCELLED') return 'neutral';
  return 'info';
}

export function getNowIST(): string {
  return getISTTimestamp();
}

export function formatNowIST(): string {
  return formatISTDateTime(new Date());
}

export function formatNowISTTime(): string {
  return formatISTTime(new Date());
}

export function formatNowISTDate(): string {
  return formatISTDate(new Date());
}

export const IST_LABEL = IST_TIMEZONE;