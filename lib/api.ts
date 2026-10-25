import { API_BASE } from './api-base';

/**
 * Backend base URL.
 *
 * In the BROWSER this is deliberately the empty string, so every request
 * becomes SAME-ORIGIN (`/api/...`). The browser in this deployment cannot open
 * a cross-origin request to `http://127.0.0.1:8000` — such a request never
 * completes, which silently froze live prices and every panel on the trade
 * page. `localhost:8000` works but is still cross-origin and still burns the
 * per-origin connection pool, so it is not used either.
 *
 * On a phone it is worse than slow: `127.0.0.1` is the PHONE, so the request
 * can never reach the server at all.
 *
 * Server-side (Node/SSR) the absolute backend URL is correct and is kept.
 * This mirrors what `searchGlobal` already did for the Search Engine; the
 * rewrite in next.config.js forwards any /api path without its own route
 * handler to the Python service, so no call site needs to change.
 */
export { API_BASE };

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Browser-only in-flight dedupe for identical GETs.
 *
 * React StrictMode mounts effects twice in development, and several panels
 * legitimately read the same endpoint at once. This collapses those into ONE
 * network request. It is deliberately NOT a response cache: the entry is
 * removed as soon as the request settles, so the next poll still observes new
 * server data. Requests with a caller-supplied AbortSignal or a body are never
 * shared (an abort must stay caller-local, and writes must never be merged).
 * Server-side calls are excluded because module state is shared across users.
 */
const inFlightGets = new Map<string, Promise<any>>();

/**
 * Build a query-string suffix from a params object, OMITTING any optional
 * parameter whose value is `undefined`, `null`, or an empty string, and any
 * `NaN` number. This prevents invalid URLs like `?limit=&status=active` that
 * the backend rejects (e.g. limit must be an integer >= 1).
 *
 * Semantically-required empty values can still be forced with the
 * `keepEmpty` set of keys (e.g. `{ search: '' }` when an empty search is meant
 * to clear a filter is still omitted here â€” pass a non-empty sentinel instead).
 */
export function buildQuery(
  params: Record<string, string | number | boolean | undefined | null>,
  keepEmpty: string[] = [],
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const originalKeys = Object.keys(params);
  for (const key of [...originalKeys, ...keepEmpty]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const v = params[key];
    if (v == null) continue;
    if (typeof v === 'number' && Number.isNaN(v)) continue;
    const sv = String(v);
    if (sv === '' && !keepEmpty.includes(key)) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(sv)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function apiFetchOnce(base: string, path: string, options?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options ?? {};
  // Timeout is only owned here when the caller didn't bring their own signal
  // (external aborts must surface as AbortError so callers can react to them).
  const ownController = init.signal == null ? new AbortController() : null;
  let timedOut = false;
  const timer = ownController
    ? setTimeout(() => {
        timedOut = true;
        // Give the abort a real reason â€” otherwise Chrome reports the cryptic
        // "signal is aborted without reason" all over the UI.
        ownController.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
      }, timeoutMs)
    : null;
  try {
    // Only attach a JSON content-type when a body is actually present (or the
    // caller explicitly supplied one). A Content-Type on a body-less GET forces
    // the browser into a CORS preflight (OPTIONS) for every single read, which
    // saturates the loopback connection pool and starves latency-sensitive
    // calls like the Global Search Engine. Simple GETs are preflight-free.
    const incoming = (init.headers as Record<string, string>) || {};
    const hasBody = init.body != null;
    const hasContentType = Object.keys(incoming).some((k) => k.toLowerCase() === 'content-type');
    const headers = {
      ...incoming,
      ...(!hasContentType && hasBody ? { 'Content-Type': 'application/json' } : {}),
    };
    // Optional high-priority hint: Chromium bumps this fetch above the app's
    // background polling + SSE streams sharing the same loopback origin, so a
    // latency-sensitive call (Global Search Engine) isn't starved on a cold
    // page load when several background requests pin the connection slots.
    const priority = (init as { priority?: 'high' | 'low' | 'auto' }).priority;
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: init.signal ?? ownController?.signal,
      headers,
      cache: 'no-store',
      ...(priority ? { priority } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} ${text}`);
    }
    return res.json();
  } catch (err) {
    if (ownController && timedOut) {
      throw new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiFetch(base: string, path: string, options?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const init = options ?? {};
  const method = (init.method ?? 'GET').toUpperCase();
  // Only the bare GET shape used by the shared readers is eligible. Anything
  // that can change the response for the same URL — custom headers,
  // credentials, mode, redirect handling, cache policy, etc. — stays
  // caller-local instead of being merged with an unrelated request.
  const extraInitKeys = Object.keys(init).filter((key) => key !== 'method' && key !== 'timeoutMs');
  const canShare =
    typeof window !== 'undefined' &&
    method === 'GET' &&
    init.body == null &&
    init.signal == null &&
    extraInitKeys.length === 0;

  if (!canShare) return apiFetchOnce(base, path, options);

  const key = `${base}${path}|${init.timeoutMs ?? DEFAULT_TIMEOUT_MS}`;
  const existing = inFlightGets.get(key);
  if (existing) return existing;

  const pending = apiFetchOnce(base, path, options);
  inFlightGets.set(key, pending);
  const release = () => {
    if (inFlightGets.get(key) === pending) inFlightGets.delete(key);
  };
  // Attach both handlers so a rejection is still observed by the waiter and
  // the map cannot retain a settled promise.
  pending.then(release, release);
  return pending;
}

// ---- System / Health ----
export const getNodeHealth = (): Promise<any> => apiFetch(API_BASE, '/health');
export const getSystemStatus = (): Promise<any> => apiFetch(API_BASE, '/api/system');
export const getSystemMarket = (): Promise<any> => apiFetch(API_BASE, '/api/system/market');
export const getSystemTime = (): Promise<any> => apiFetch(API_BASE, '/api/system/time');
export const getBrokersStatus = (): Promise<any> => apiFetch(API_BASE, '/api/trading/brokers/status', { timeoutMs: 45000 });
export const getBrokerTerminalOverview = (): Promise<any> => apiFetch(API_BASE, '/api/trading/brokers/overview', { timeoutMs: 45000 });
/** POST â€” invalidates the shared broker cache and re-runs the Broker Terminal
 * Engine (real broker reads, never a 5s cache hit). The engine pass reads
 * every adapter, so it gets a long timeout instead of tripping a 15s abort. */
export const refreshBrokerOverview = (): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/brokers/refresh', { method: 'POST', timeoutMs: 45000 });
export const getSessionManagerSession = (): Promise<any> =>
  apiFetch(API_BASE, '/api/phase3/session-manager/session', { timeoutMs: 30000 });
export const getStatistics = (params = ''): Promise<any> => apiFetch(API_BASE, `/api/statistics${params}`);
export const getLogs = (params = ''): Promise<any> => apiFetch(API_BASE, `/api/logs${params}`);

// ---- Stocks ----
export const getStocks = (q = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/stocks${q ? `?q=${encodeURIComponent(q)}` : ''}`);
export const addStock = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/stocks', { method: 'POST', body: JSON.stringify(data) });
export const deleteStock = (symbol: string): Promise<any> =>
  apiFetch(API_BASE, `/api/stocks/${symbol}`, { method: 'DELETE' });
export const toggleStock = (symbol: string, active: boolean): Promise<any> =>
  apiFetch(API_BASE, `/api/stocks/${symbol}`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const bulkDeleteStocks = (symbols: string[]): Promise<any> =>
  apiFetch(API_BASE, '/api/stocks/bulk', { method: 'DELETE', body: JSON.stringify({ symbols }) });
/** @deprecated Use `lib/instrument-search-client.ts` (canonical `/api/search`). */
export const searchStockInfo = (searchText: string, signal?: AbortSignal): Promise<any> =>
  apiFetch(API_BASE, '/api/stocks/search', {
    method: 'POST', signal, body: JSON.stringify({ search_text: searchText }),
  });

/** @deprecated Use `lib/instrument-search-client.ts` (canonical `/api/search`). */
export const searchInstruments = (q: string, limit = 15, signal?: AbortSignal): Promise<any> =>
  apiFetch(API_BASE, `/api/stocks/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal });

// ---- Settings ----
export const getSettings = (): Promise<any> => apiFetch(API_BASE, '/api/settings');
export const updateSetting = (key: string, value: any): Promise<any> =>
  apiFetch(API_BASE, `/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
export const resetSetting = (key: string): Promise<any> =>
  apiFetch(API_BASE, `/api/settings/${key}/reset`, { method: 'POST' });
export const resetAllSettings = (): Promise<any> =>
  apiFetch(API_BASE, '/api/settings/reset-all', { method: 'POST' });

/** Which settings keys drive the live backend runtime (scheduler/WS/tick). */
export const getSettingsRuntime = (): Promise<any> => apiFetch(API_BASE, '/api/settings/runtime');

// ---- Downloads ----
export const getDownloadUrl = (params: Record<string, string>): string => {
  const qs = new URLSearchParams(params).toString();
  return `${API_BASE}/api/downloads?${qs}`;
};

export const downloadFile = async (params: Record<string, string>): Promise<{ blob: Blob; filename: string }> => {
  const url = getDownloadUrl(params);
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
  const filename = filenameMatch ? filenameMatch[1] : `download_${Date.now()}`;
  const blob = await res.blob();
  return { blob, filename };
};

export const getDownloadFormats = (): Promise<any> => apiFetch(API_BASE, '/api/downloads/formats');
export const getDownloadFields = (): Promise<any> => apiFetch(API_BASE, '/api/downloads/fields');
export const getDownloadStats = (): Promise<any> => apiFetch(API_BASE, '/api/downloads/stats');

// ---- Export jobs (Data Center download pipeline) ----
export type ExportJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export type ExportJob = {
  id: string;
  status: ExportJobStatus;
  stage: string;
  progressPercent: number;
  stocks: string[];
  missingSymbols?: string[];
  dataType: string;
  fields: string[];
  formats: string[];
  packageZip: boolean;
  dateStart?: string | null;
  dateEnd?: string | null;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  fileName?: string | null;
  fileSize?: number | null;
  recordCount?: number | null;
  error?: string | null;
};

export async function createExportJob(payload: {
  symbols?: string[];
  symbolMode?: string;
  start?: string;
  end?: string;
  fields?: string;
  formats: string[];
  packageZip?: boolean;
  clientId?: string;
}): Promise<{ jobId: string; duplicate?: boolean }> {
  return apiFetch(API_BASE, '/api/downloads/exports', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 30000,
  });
}

export async function getExportJob(id: string): Promise<ExportJob> {
  const d = await apiFetch(API_BASE, `/api/downloads/exports/${id}`);
  return d.job;
}

/** Streams the generated artifact â€” caller turns the Blob into a browser download. */
export async function fetchExportArtifact(id: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_BASE}/api/downloads/exports/${id}/download`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const filename = match ? decodeURIComponent(match[1]) : `export_${id}.zip`;
  const blob = await res.blob();
  return { blob, filename };
}

export const cancelExportJob = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/downloads/exports/${id}/cancel`, { method: 'POST' });

export const deleteHistoryEntry = (id: string): Promise<{ deleted: boolean; fileDeleted: boolean }> =>
  apiFetch(API_BASE, `/api/downloads/history/${id}`, { method: 'DELETE' });

export const bulkDeleteHistory = (): Promise<{ deleted: number; filesDeleted: number }> =>
  apiFetch(API_BASE, '/api/downloads/history/bulk', { method: 'DELETE' });

export const retryExportJob = (id: string): Promise<{ jobId: string; duplicate?: boolean }> =>
  apiFetch(API_BASE, `/api/downloads/exports/${id}/retry`, { method: 'POST', timeoutMs: 15000 });

/** Streams the stored artifact for a history entry (scheduled exports etc.). */
export async function fetchHistoryFile(id: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_BASE}/api/downloads/history/${id}/file`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const filename = match ? decodeURIComponent(match[1]) : `history_${id}.zip`;
  const blob = await res.blob();
  return { blob, filename };
}

// ---- Scheduled-download run history ----
export const getScheduleRuns = (params?: { limit?: number; offset?: number; scheduleId?: string }): Promise<any> => {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.scheduleId) qs.set('schedule_id', params.scheduleId);
  const q = qs.toString();
  return apiFetch(API_BASE, `/api/scheduled-downloads/runs${q ? `?${q}` : ''}`);
};
/** Pre-download estimate from the backend (real document counts + sampled size). */
export const getDownloadPreview = (params: Record<string, string>): Promise<any> => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(API_BASE, `/api/downloads/preview?${qs}`);
};
export const getNamingPreview = (params: Record<string, string>): Promise<any> => {
  const qs = new URLSearchParams(params).toString();
  return apiFetch(API_BASE, `/api/downloads/naming/preview?${qs}`);
};
export const getDownloadHistory = (params?: {
  limit?: number;
  offset?: number;
  search?: string;
  format?: string;
  source?: string;
}): Promise<any> => {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.search) qs.set('search', params.search);
  if (params?.format) qs.set('format', params.format);
  if (params?.source) qs.set('source', params.source);
  const q = qs.toString();
  return apiFetch(API_BASE, `/api/downloads/history${q ? `?${q}` : ''}`);
};

// ---- Data Quality ----
export const getDataQuality = <T = any>(path: string, params?: Record<string, string | number>, timeoutMs?: number): Promise<T> => {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null && String(v) !== '') qs.set(k, String(v));
    }
  }
  const q = qs.toString();
  return apiFetch(API_BASE, `/api/data-quality/${path}${q ? `?${q}` : ''}`, { timeoutMs: timeoutMs ?? 60000 });
};

export const postDataQuality = <T = any>(path: string, body?: Record<string, unknown>): Promise<T> =>
  apiFetch(API_BASE, `/api/data-quality/${path}`, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });

// ---- Scheduled Downloads ----
export const getScheduledDownloads = (): Promise<any> =>
  apiFetch(API_BASE, '/api/scheduled-downloads');

export const getScheduledDownload = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/${id}`);

export const createScheduledDownload = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/scheduled-downloads', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateScheduledDownload = (id: string, data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteScheduledDownload = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/${id}`, { method: 'DELETE' });

export const toggleScheduledDownload = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/${id}/toggle`, { method: 'POST' });

export const runScheduledDownloadNow = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/${id}/run`, { method: 'POST' });

export const getDownloadDestinations = (): Promise<any> =>
  apiFetch(API_BASE, '/api/scheduled-downloads/destinations/list');

export const duplicateScheduledDownload = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/${id}/duplicate`, { method: 'POST' });

export const testScheduledDownloadConfig = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/scheduled-downloads/test-config', {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ---- Packages (generated export artifacts) ----
export const getSchedulePackages = (params?: { limit?: number; offset?: number; scheduleId?: string }): Promise<any> => {
  const q = new URLSearchParams();
  if (params?.limit) q.set('limit', String(params.limit));
  if (params?.offset) q.set('offset', String(params.offset));
  if (params?.scheduleId) q.set('scheduleId', params.scheduleId);
  const qs = q.toString();
  return apiFetch(API_BASE, `/api/scheduled-downloads/packages${qs ? `?${qs}` : ''}`);
};

export const getSchedulePackage = (packageId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/packages/${packageId}`);

export const triggerPackageDownload = (packageId: string, action = 'start'): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduled-downloads/packages/${packageId}/download`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });

// ---- Schedule SSE events stream ----
export const getScheduleEventsUrl = (): string => `${API_BASE}/api/schedule-events/stream`;

// ---- Scheduler Engine (IST-FIVE lifecycle; raw dict payloads, not {ok,data}) ----
export const getSchedulerStatus = (): Promise<any> => apiFetch(API_BASE, '/api/scheduler/status');
export const getSchedulerSettingsPreview = (): Promise<any> => apiFetch(API_BASE, '/api/scheduler/settings-preview');
export const getSchedulerReadiness = (): Promise<any> => apiFetch(API_BASE, '/api/scheduler/readiness');
export const getSchedulerSummary = (): Promise<any> => apiFetch(API_BASE, '/api/scheduler/summary');
export const getSchedulerHistory = (limit = 50, business_date?: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduler/history?limit=${limit}${business_date ? `&business_date=${encodeURIComponent(business_date)}` : ''}`);

// Paginated scheduler-run ledger for the Runs page. `status`/`trigger` accept
// comma-separated vocab lists; the backend expands them onto real records.
export const getSchedulerRuns = (params: Record<string, string | number | boolean | undefined | null> = {}): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduler/runs${buildQuery(params)}`);
export const getSchedulerRun = (runId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/scheduler/runs/${encodeURIComponent(runId)}`);

// ---- Connection Manager (WS #2 control plane) ----
export const getRealtimeHealth = (): Promise<any> => apiFetch(API_BASE, '/api/realtime/health');
export const getRealtimeConfig = (): Promise<any> => apiFetch(API_BASE, '/api/realtime/config');
export const getRealtimeEvents = (params: Record<string, string | number | boolean | undefined | null> = {}): Promise<any> =>
  apiFetch(API_BASE, `/api/realtime/events${buildQuery(params)}`);
export const getRealtimeConnection = (connectionId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/realtime/connections/${encodeURIComponent(connectionId)}`);

// ---- Watchlist ----
export const getWatchlist = (): Promise<any> => apiFetch(API_BASE, '/api/watchlist');
export const addToWatchlist = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/watchlist', { method: 'POST', body: JSON.stringify(data) });
export const removeFromWatchlist = (symbol: string): Promise<any> =>
  apiFetch(API_BASE, `/api/watchlist/${symbol}`, { method: 'DELETE' });
export const toggleWatchlistFavorite = (symbol: string): Promise<any> =>
  apiFetch(API_BASE, `/api/watchlist/${symbol}/favorite`, { method: 'PATCH' });

/** Watchlist Engine: normalize stocks into the stable live card model
 *  (LTP, change, %, 5-min %, 10-min %, bid/ask/spread, status). */
export type WatchlistCard = {
  symbol: string;
  tradingSymbol?: string;
  companyName?: string;
  token: string;
  exchange: string;
  exchangeSegment?: string;
  ltp: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  fiveMinPercent: number | null;
  tenMinPercent: number | null;
  lastTick: string | null;
  tickAgeSeconds: number | null;
  status: 'LIVE' | 'STALE' | 'CONNECTING' | 'DISCONNECTED';
};

export const getWatchlistCards = (
  stocks: { symbol?: string; token: string; exchange?: string; exchangeSegment?: string; tradingSymbol?: string; companyName?: string; isin?: string }[],
): Promise<{ data: WatchlistCard[] }> =>
  apiFetch(API_BASE, '/api/watchlist-engine/cards', {
    method: 'POST',
    body: JSON.stringify({ stocks }),
  });

export const getWatchlistDynamicList = (
  kind: string,
  opts: { watchlistId?: string; limit?: number } = {},
): Promise<{ kind: string; data: WatchlistCard[] }> =>
  apiFetch(API_BASE, `/api/watchlist-engine/dynamic/${encodeURIComponent(kind)}${buildQuery({
    watchlistId: opts.watchlistId,
    limit: opts.limit ?? 20,
  })}`);

export const getWatchlistDynamicKinds = (): Promise<{ data: string[] }> =>
  apiFetch(API_BASE, '/api/watchlist-engine/meta/dynamic-kinds');

export const getWatchlistDynamicListFor = (
  kind: string,
  stocks: { symbol?: string; token: string; exchange?: string }[],
  limit = 20,
): Promise<{ kind: string; data: WatchlistCard[] }> =>
  apiFetch(API_BASE, `/api/watchlist-engine/dynamic/${encodeURIComponent(kind)}`, {
    method: 'POST',
    body: JSON.stringify({ stocks, limit }),
  });

// ---- Notifications ----
export const getNotifications = (params = ''): Promise<any> => apiFetch(API_BASE, `/api/notifications${params}`);
export const getNotificationDetail = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/notifications/${id}`);
export const getNotificationSummary = (): Promise<any> => apiFetch(API_BASE, '/api/notifications/summary');
export const getNotificationUnreadCount = (): Promise<any> => apiFetch(API_BASE, '/api/notifications/unread-count');
export const markNotificationRead = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/notifications/read/${id}`, { method: 'PUT' });
export const markNotificationUnread = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/notifications/unread/${id}`, { method: 'PUT' });
export const markAllNotificationsRead = (): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications/read-all', { method: 'PUT' });
export const markNotificationsMany = (ids: string[], read: boolean): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications/mark-many', {
    method: 'POST',
    body: JSON.stringify({ notification_ids: ids, read }),
  });
export const deleteNotification = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/notifications/${id}`, { method: 'DELETE' });
export const deleteNotificationsMany = (ids: string[]): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications/delete-many', {
    method: 'POST',
    body: JSON.stringify({ notification_ids: ids }),
  });
export const deleteReadNotifications = (): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications/delete-read', { method: 'POST' });
export const clearAllNotifications = (): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications?confirm=true', { method: 'DELETE' });
export const getNotificationSettings = (): Promise<any> => apiFetch(API_BASE, '/api/notifications/settings');
export const updateNotificationSettings = (patch: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications/settings', { method: 'PATCH', body: JSON.stringify(patch) });
/** Push one real notification (title/message/severity) into the Notification Center. */
export const createNotification = (payload: {
  title: string;
  message: string;
  severity?: 'info' | 'success' | 'warning' | 'error' | 'critical';
  category?: string;
  source?: string;
  event_type?: string;
  meta?: Record<string, unknown>;
}): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications', {
    method: 'POST',
    body: JSON.stringify({ category: 'system', ...payload }),
  });

// ---- Alerts (Notification Center /api/alerts) ----
export const getAlerts = (params = ''): Promise<any> => apiFetch(API_BASE, `/api/alerts${params}`);
export const getAlertSummary = (): Promise<any> => apiFetch(API_BASE, '/api/alerts/summary');
export const getAlertRules = (): Promise<any> => apiFetch(API_BASE, '/api/alerts/rules');
export const setAlertRuleEnabled = (ruleId: string, enabled: boolean): Promise<any> =>
  apiFetch(API_BASE, `/api/alerts/rules/${ruleId}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
export const getAlertDetail = (alertId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/alerts/${alertId}`);
export const acknowledgeAlert = (alertId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/alerts/${alertId}/acknowledge`, { method: 'POST' });
export const acknowledgeAllAlerts = (): Promise<any> =>
  apiFetch(API_BASE, '/api/alerts/acknowledge-all', { method: 'POST' });
export const resolveAlert = (alertId: string, reason = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/alerts/${alertId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
export const deleteAlert = (alertId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/alerts/${alertId}`, { method: 'DELETE' });
export const clearResolvedAlerts = (): Promise<any> =>
  apiFetch(API_BASE, '/api/alerts', { method: 'DELETE' });
export const getAlertSettings = (): Promise<any> => apiFetch(API_BASE, '/api/alerts/settings');
export const updateAlertSettings = (patch: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/alerts/settings', { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteAlertsMany = (alertIds: string[]): Promise<any> =>
  apiFetch(API_BASE, '/api/alerts/delete-many', {
    method: 'POST',
    body: JSON.stringify({ alert_ids: alertIds }),
  });
export const deleteAllAlerts = (filters?: Record<string, string>): Promise<any> =>
  apiFetch(API_BASE, '/api/alerts/delete-all', {
    method: 'POST',
    body: JSON.stringify({ confirm: true, status: '', category: '', severity: '', ...filters }),
  });

// ---- WebSocket history & diagnostics (real backend) ----
export const getWebsocketStatus = (): Promise<any> => apiFetch(API_BASE, '/api/websocket/status');
export const getWebsocketHistory = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/history${params}`);
export const getWebsocketRecord = (connectionId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/history/${connectionId}`);
export const deleteWebsocketRecord = (connectionId: string): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/history/${connectionId}`, { method: 'DELETE' });
export const getWebsocketEvents = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/events${params}`);
export const getWebsocketDaily = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/daily${params}`);
export const getWebsocketMetrics = (hours = 24): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/metrics?hours=${hours}`);
export const clearWebsocketHistory = (): Promise<any> =>
  apiFetch(API_BASE, '/api/websocket/history/clear-all', { method: 'POST' });
export const runWebsocketCleanup = (): Promise<any> =>
  apiFetch(API_BASE, '/api/websocket/cleanup', { method: 'POST' });
export const getWebsocketTelemetry = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/telemetry${params}`);
export const getWebsocketStreamUrl = (): string => `${API_BASE}/api/websocket/stream`;

// ---- WebSocket monitor (real-only live frames, availability, subscriptions) ----
export const getWebsocketLive = (): Promise<any> => apiFetch(API_BASE, '/api/websocket/live');
export const getWebsocketSubscriptions = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/subscriptions${params}`);
export const getWebsocketEventsFiltered = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/events${params}`);
export const getWebsocketTelemetrySeries = (params = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/websocket/telemetry${params}`);
export const runWebsocketCleanupDays = (days: number): Promise<any> =>
  apiFetch(API_BASE, '/api/websocket/cleanup', { method: 'POST', body: JSON.stringify({ days }) });
export const exportWebsocketUrl = (hours: number, format = 'csv'): string =>
  `${API_BASE}/api/websocket/export?hours=${hours}&format=${format}`;

// ---- Trading (direct to Python â†’ Kotak SDK) ----
export const placeOrder = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/order/place', { method: 'POST', body: JSON.stringify(data) });
export const modifyOrder = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/order/modify', { method: 'POST', body: JSON.stringify(data) });
export const cancelOrder = (orderId: string): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/order/cancel', { method: 'POST', body: JSON.stringify({ order_id: orderId }) });
export const getOrderBook = (): Promise<any> => apiFetch(API_BASE, '/api/trading/orders');
export const getOrderHistory = (book = 'orders', orderId = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/trading/order/history?book=${book}&order_id=${orderId}`);
export const getPositions = (): Promise<any> => apiFetch(API_BASE, '/api/trading/positions');
export const squareOffPosition = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/positions/squareoff', { method: 'POST', body: JSON.stringify(data) });
export const getHoldings = (): Promise<any> => apiFetch(API_BASE, '/api/trading/holdings');
export const getFunds = (): Promise<any> => apiFetch(API_BASE, '/api/trading/funds');

// ---- Consolidated trading dashboard (ONE terminal-aware snapshot) ----
export type DashboardSectionStatus =
  | 'ok'
  | 'not_configured'
  | 'not_logged_in'
  | 'unavailable'
  | 'error';

export type CanonicalFunds = {
  balance: number | null;
  usedMargin: number | null;
  freeMargin: number | null;
  totalPnl: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  totalCharges: number | null;
  dailyOrders: number | null;
  cash: number | null;
  blockedMargin: number | null;
  [key: string]: any;
};

export type DashboardSection<T = any> = {
  status: DashboardSectionStatus;
  source: string;
  timestamp: string | null;
  data: T;
  error: string | null;
  count: number | null;
  isDemo?: boolean;
  totals?: Record<string, any> | null;
};

export type TradingDashboardResponse = {
  ok: boolean;
  terminal: string;
  broker: string;
  isDemo: boolean;
  isLoggedIn: boolean;
  enabled: boolean;
  generatedAt: string;
  sections: {
    funds: DashboardSection<CanonicalFunds | null>;
    positions: DashboardSection<any[]>;
    holdings: DashboardSection<any[]>;
    orders: DashboardSection<any[]>;
  };
};

export const getTradingDashboard = (): Promise<TradingDashboardResponse> =>
  apiFetch(API_BASE, '/api/trading/dashboard', { timeoutMs: 45000 });
/** @deprecated Broker scrip passthrough. Use `lib/instrument-search-client.ts`. */
export const searchScrip = (exchange: string, searchText: string, signal?: AbortSignal): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/search', {
    method: 'POST', signal, body: JSON.stringify({ exchange, search_text: searchText }),
  });
/** @deprecated Use `lib/instrument-search-client.ts` (canonical `/api/search`). */
export const searchScripLocal = (exchange: string, searchText: string, signal?: AbortSignal): Promise<SearchLocalResponse> =>
  apiFetch(API_BASE, '/api/trading/search-local', {
    method: 'POST', signal, body: JSON.stringify({ exchange, search_text: searchText }),
  });
/** Global Search Engine (docs/engines/search-engine.md): ranked stocks with
 *  canonical live state and authoritative 1-Qty margin. Not a broker call from
 *  the browser â€” the backend owns the tick stream and margin authority. */
export const searchGlobal = (
  q: string,
  opts: { scope?: string; limit?: number; cursor?: number; withMargin?: boolean; signal?: AbortSignal; priority?: 'high' | 'low' | 'auto' } = {},
): Promise<GlobalSearchResponse> => {
  const qs = buildQuery(
    {
      q,
      scope: opts.scope ?? 'stocks',
      limit: opts.limit ?? 10,
      cursor: opts.cursor ?? 0,
      withMargin: opts.withMargin ?? false,
    },
    ['q'],
  );
  // Browser: call the SAME-ORIGIN /api/search proxy (Next route) so we never
  // depend on a fragile cross-origin loopback fetch to the Python backend.
  // Server-side (SSR/Node) keep hitting the backend directly.
  return apiFetch(typeof window !== 'undefined' ? '' : API_BASE, `/api/search${qs}`, { signal: opts.signal, priority: opts.priority });
};
export const getInstrumentCacheStatus = (): Promise<InstrumentCacheStatus> => apiFetch(API_BASE, '/api/trading/instrument-cache/status');
export const reloadInstrumentCache = (): Promise<InstrumentCacheStatus & { success: boolean }> =>
  apiFetch(API_BASE, '/api/trading/instrument-cache/reload', { method: 'POST' });
export const getQuote = (tokens: Record<string, any>[], quoteType = 'ltp', isIndex = false): Promise<QuoteResponse> =>
  apiFetch(API_BASE, '/api/trading/quote', { method: 'POST', body: JSON.stringify({ instrument_tokens: tokens, quote_type: quoteType, isIndex }) });
/** Subscribe instruments to the SHARED backend WebSocket so their ticks flow
 *  through the single /api/ticks/stream SSE connection. */
export const subscribeInstruments = (tokens: Record<string, any>[]): Promise<any> =>
  apiFetch(API_BASE, '/subscribe', { method: 'POST', body: JSON.stringify({ instrument_tokens: tokens }) });
/** Unsubscribe instruments from the SHARED backend WebSocket (real supervisor op). */
export const unsubscribeInstruments = (tokens: Record<string, any>[]): Promise<any> =>
  apiFetch(API_BASE, '/unsubscribe', { method: 'POST', body: JSON.stringify({ instrument_tokens: tokens }) });

// ---- Market-watch merged snapshot (real live-feed data, no broker session) ----

export type MarketWatchTickRow = {
  token: string;
  exists?: boolean;
  hasData?: boolean;
  symbol?: string;
  tradingSymbol?: string;
  ltp?: number | null;
  change?: number | null;
  changePercent?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  volume?: number | null;
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
  circuitPercent?: number | null;
  circuitSafe?: boolean | null;
  dataQuality?: string | null;
  circuit?: Record<string, any>;
  [key: string]: any;
};

export type MarketWatchTickResponse = {
  ok: boolean;
  session?: boolean;
  rows: Record<string, MarketWatchTickRow>;
};

/** Real merged quote + circuit snapshot for the given NSE EQ tokens, straight
 *  from the central tick store (the live WS feed). Rows without a tick carry
 *  `hasData: false` so the client keeps its last snapshot instead of wiping it. */
export const getMarketWatchTickSnapshot = (
  tokens: (string | number)[],
): Promise<MarketWatchTickResponse> => {
  const list = tokens.filter((t) => t != null && String(t).trim() !== '').map((t) => String(t).trim());
  return apiFetch(API_BASE, `/api/market-watch/tick-snapshot?tokens=${encodeURIComponent(list.join(','))}`);
};

// ---- Type definitions ----

export type GlobalSearchResult = SearchScripResult & {
  type: 'stock' | string;
  id?: string;
  name?: string;
  isin?: string;
  lotSize?: number;
  tickSize?: number;
  ltp?: number | null;
  prevClose?: number | null;
  change?: number | null;
  changePct?: number | null;
  volume?: number | null;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  /** Broker-published circuit bands. `null` when the feed did not carry them. */
  upperCircuit?: number | null;
  lowerCircuit?: number | null;
  /** ISO-8601 UTC string from the canonical tick store. */
  timestamp?: string | number | null;
  tickAgeSeconds?: number | null;
  liveStatus?: 'LIVE' | 'STALE' | 'UNAVAILABLE';
  /** Mirrors `liveStatus`; distinct name for the shared contract. */
  dataStatus?: 'LIVE' | 'STALE' | 'UNAVAILABLE';
  source?: string | null;
  oneQtyMargin?: number | null;
  marginStatus?: 'AVAILABLE' | 'UNAVAILABLE' | 'STALE' | 'REQUIRES_ORDER_CONTEXT';
  marginSource?: string | null;
  marginReason?: string | null;
};

export type GlobalSearchResponse = {
  query: string;
  normalized: string;
  results: GlobalSearchResult[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  scopes: string[];
  tookMs: number;
  errorCode: string | null;
};

export type SearchLocalResponse = {
  data: SearchScripResult[];
  stat: string;
  source: 'cache' | 'kotak_api';
  cache_ms?: number;
  backend_ms?: number;
  total_ms: number;
  instrument_count?: number;
};

export type SearchScripResult = {
  pSymbolName?: string;
  symbol?: string;
  pSymbol?: string;
  token?: string;
  pExchSeg?: string;
  exchange?: string;
  pTrdSymbol?: string;
  tradingSymbol?: string;
  pDesc?: string;
  companyName?: string;
  pInstType?: string;
  instrumentType?: string;
  pSeries?: string;
  series?: string;
  exchangeSegment?: string;
  [key: string]: any;
};

export type QuoteResponse = {
  data: QuoteDataRaw[] | QuoteDataRaw;
  stat?: string;
};

export type QuoteDataRaw = {
  ltp?: number | string;
  last_price?: number | string;
  upper_circuit?: number | string;
  lower_circuit?: number | string;
  ohlc?: { open?: number | string; high?: number | string; low?: number | string; close?: number | string };
  depth?: {
    buy?: Array<{ price: number | string; quantity: number | string; orders: number | string }>;
    sell?: Array<{ price: number | string; quantity: number | string; orders: number | string }>;
  };
  volume?: number | string;
  total_buy_qty?: number | string;
  total_sell_qty?: number | string;
  average_price?: number | string;
  margin_required?: number | string;
  mis_available?: boolean;
  [key: string]: any;
};

export type OrderBookEntry = {
  n_ord_no?: string;
  order_id?: string;
  trading_symbol?: string;
  symbol?: string;
  transaction_type?: string;
  product?: string;
  order_type?: string;
  quantity?: string;
  price?: string;
  trigger_price?: string;
  status?: string;
  order_date?: string;
  ts?: string;
  [key: string]: any;
};

export type OrderHistoryResponse = {
  data: OrderBookEntry[];
  stat?: string;
};

export type FundsResponse = {
  data: {
    limitObject?: {
      RMS?: {
        available_margin?: string;
        cash_margin_available?: string;
        used_margin?: string;
        collateral_margin?: string;
        utilised_debit?: string;
        [key: string]: any;
      };
    };
    [key: string]: any;
  };
  stat?: string;
};

export type PositionEntry = {
  sym?: string;
  sym_clean?: string;
  trdSym?: string;
  trdSym_clean?: string;
  net_qty?: number;
  avg_price?: number;
  average_price?: number;
  ltp?: number;
  unrealised?: number;
  product?: string;
  prod_clean?: string;
  exSeg?: string;
  exchange?: string;
  exchange_segment?: string;
  [key: string]: any;
};

export type PositionsResponse = {
  data: PositionEntry[];
  stat?: string;
};

export type PlaceOrderResponse = {
  data?: {
    n_ord_no?: string;
    order_id?: string;
    stat?: string;
    remarks?: string;
  };
  stat?: string;
  [key: string]: any;
};

export type BasketOrder = {
  symbol: string;
  token: string;
  exchange: string;
  transactionType: string;
  product: string;
  orderType: string;
  quantity: string;
  price: string;
  triggerPrice: string;
  /** Real observed LTP captured when the leg was composed. Sent so a
   *  price-less engine (Dummy) can execute instead of rejecting the leg.
   *  Absent / "0" means no live quote was available — never a guess. */
  expectedLtp?: string;
  status?: string;
  orderId?: string | null;
  error?: string | null;
};

/** Per-leg outcome of a basket pushed through the Single Order choke point.
 *  Mirrors the backend contract so the UI never has to guess a leg's state. */
export type BasketExecResult = {
  index: number;
  symbol: string;
  accepted: boolean;
  orderId: string | null;
  status: string | null;
  error: string | null;
  reason?: string;
  raw: Record<string, any>;
};

export type Basket = {
  _id: string;
  name: string;
  orders: BasketOrder[];
  status: string;
  cancelOnFill: boolean;
  createdAt: string;
  updatedAt: string;
  /** Broker this basket executes against (dummy | kotak | shoonya). */
  terminal?: string;
  executedAt?: string;
  maxOrders?: number;
  allocatedAmount?: number;
  expiry?: string;
  totalOrders?: number;
  pendingOrders?: number;
  executedOrders?: number;
  rejectedOrders?: number;
  cancelledOrders?: number;
};

export type InstrumentCacheStatus = {
  loaded: boolean;
  instrument_count: number;
  exchange_count: number;
  exchanges?: string[];
  load_time_ms?: number;
  last_updated?: string;
  error?: string;
};

// ---- Session / Python service ----
export const getPythonHealth = (): Promise<any> => apiFetch(API_BASE, '/health');
export const getPythonStatus = (): Promise<any> => apiFetch(API_BASE, '/status');

/**
 * Manual broker login.
 *
 * These MUST use the `/api/*` aliases, not the bare `/login` and `/logout`
 * paths. In the browser `API_BASE` is `''` (same-origin by design), so a bare
 * `/login` was resolving to the Next.js LOGIN PAGE at `/login` — it returned
 * 200 with that page's HTML, so no broker login ever ran, and because
 * `res.ok` on an HTML string is `undefined`, every caller read it as success.
 * `POST /api/login` + `POST /api/logout` are the backend's own aliases of the
 * same `_login_impl()` / `_logout_impl()` handlers
 * (python-service/api/routes.py), and `next.config.js` forwards `/api/:path*`
 * to the Python service, so one call works from both the browser and SSR.
 */
export const triggerLogin = (): Promise<any> => apiFetch(API_BASE, '/api/login', { method: 'POST' });
export const triggerLogout = (): Promise<any> => apiFetch(API_BASE, '/api/logout', { method: 'POST' });
export const getPythonSession = (): Promise<any> => apiFetch(API_BASE, '/api/session/status');

// ---- Live Ticks ----
export const getRecentTicks = (limit = 50, symbol = '', compact = false): Promise<any> =>
  apiFetch(
    API_BASE,
    `/api/ticks/recent?limit=${limit}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}${compact ? '&compact=1' : ''}`,
  );
export const getTickStreamUrl = (): string => `${API_BASE}/api/ticks/stream`;

// ---- Centralized realtime system stream (backend SSR/state push) ----
export const getSystemStreamUrl = (): string => `${API_BASE}/api/websocket/system/stream`;
export const getSystemStreamStatus = (): Promise<any> =>
  apiFetch(API_BASE, '/api/websocket/system/status');

// ---- Baskets ----
export const getBaskets = (): Promise<any> => apiFetch(API_BASE, '/api/baskets');

/** Dummy terminal order preview: server-side charges + margin estimate from
 *  the paper engine's configured charge model (never derived in the browser). */
export const getDummyPreview = (body: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/dummy/preview', { method: 'POST', body: JSON.stringify(body) });
export const createBasket = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/baskets', { method: 'POST', body: JSON.stringify(data) });
export const updateBasket = (id: string, data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteBasket = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}`, { method: 'DELETE' });
/** Push a basket onto the broker order engine. `terminal` pins WHICH broker
 *  runs it — without it the backend falls back to the terminal the basket was
 *  created under, then the live session terminal. Passing the page's terminal
 *  is what keeps Dummy legs on the Dummy adapter and Kotak legs on Kotak. */
export const pushBasket = (id: string, terminal?: string): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}/push`, {
    method: 'POST',
    body: JSON.stringify(terminal ? { terminal } : {}),
  });
export const getBasket = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}`);

// ---- Gainers/Losers ----
export const getGainersLosers = (filter = 0, limit = 20): Promise<any> =>
  apiFetch(API_BASE, `/api/statistics/gainers-losers?filter=${filter}&limit=${limit}`);

// ---- System extended ----
export const getMongoStats = (): Promise<any> => apiFetch(API_BASE, '/api/system/mongo-stats');
export const clearLogs = (category?: string): Promise<any> =>
  apiFetch(API_BASE, '/api/system/logs/clear', { method: 'POST', body: JSON.stringify({ category }) });
export const getTradingDayStats = (date?: string): Promise<any> =>
  apiFetch(API_BASE, `/api/system/trading-day-stats${date ? `?date=${date}` : ''}`);
export const getTradingHistory = (range = 'daily', limit = 30): Promise<any> =>
  apiFetch(API_BASE, `/api/system/trading-history?range=${range}&limit=${limit}`);

// ---- Service Phase trading-family engines ----
// Risk Engine (core/engines/risk_engine.py + api/risk_engine.py, mounted).
export const getRiskConfig = (): Promise<any> =>
  apiFetch(API_BASE, '/api/services/risk/config');
export const validateRiskOrder = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/services/risk/validate', { method: 'POST', body: JSON.stringify(data) });
export const getRiskSnapshot = (terminal: string): Promise<any> =>
  apiFetch(API_BASE, `/api/services/risk/snapshot?terminal=${encodeURIComponent(terminal)}`);
// Margin Engine (api/trading.py /margin + api/terminal.py /margin).
export const getMarginPreview = (params: Record<string, string | number> = {}): Promise<any> =>
  apiFetch(API_BASE, `/api/trading/margin${buildQuery(params)}`);
// Broker Terminal (api/terminal.py list/state/audit; api/trading_dashboard.py brokers/status).
export const getTerminalList = (): Promise<any> => apiFetch(API_BASE, '/api/terminal/list');
export const getTerminalState = (): Promise<any> => apiFetch(API_BASE, '/api/terminal/state');
export const getTerminalAudit = (limit = 100): Promise<any> =>
  apiFetch(API_BASE, `/api/terminal/audit?limit=${limit}`);
// Squareoff Engine (api/trading.py positions/squareoff + engine_control detail/history/run).
export const squareOffTradingPosition = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/positions/squareoff', { method: 'POST', body: JSON.stringify(data) });
// Same-origin proxy in the browser (Next /api/services/engines/[...path] →
// backend engine_control router). Keeps engine reads preflight-free and off
// the loopback pool, matching the trade-page proxy rationale above.
const enginesProxyBase = (): string => (typeof window !== 'undefined' ? '' : API_BASE);
export const getSquareoffDetail = (): Promise<any> =>
  apiFetch(enginesProxyBase(), '/api/services/engines/squareoff_engine/detail');
export const getSquareoffHistory = (limit = 20): Promise<any> =>
  apiFetch(enginesProxyBase(), `/api/services/engines/squareoff_engine/history?limit=${limit}`);
export const runSquareoffNow = (terminal = 'kotak', source = 'manual'): Promise<any> =>
  apiFetch(enginesProxyBase(), '/api/services/engines/squareoff_engine/run', {
    method: 'POST', body: JSON.stringify({ terminal, source, confirmation_token: 'CONFIRM' }),
  });
// Target Engine (api/terminal.py /target + api/dummy.py /targets).
export const getTargets = (): Promise<any> => apiFetch(API_BASE, '/api/dummy/targets');
export const placeTarget = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/terminal/target', { method: 'POST', body: JSON.stringify(data) });
export const deleteTarget = (symbol: string): Promise<any> =>
  apiFetch(API_BASE, `/api/terminal/target/${encodeURIComponent(symbol)}`, { method: 'DELETE' });

// ---- Demo Trading (Dummy Trading Engine) ----
export const getDemoAccount = (): Promise<any> => apiFetch(API_BASE, '/api/demo/account');
export const getDemoOrders = (): Promise<any> => apiFetch(API_BASE, '/api/demo/orders');
// Dummy-engine reads/writes that power the trade page's order card. Routed
// SAME-ORIGIN through Next proxy routes in the browser (same rationale as the
// search proxy: no fragile cross-origin loopback fetch / connection-pool
// starvation). SSR keeps hitting the Python backend directly.
const tradeProxyBase = (): string => (typeof window !== 'undefined' ? '' : API_BASE);
export const getDemoPositions = (): Promise<any> => apiFetch(tradeProxyBase(), '/api/trade/demo/positions');
export const getDemoTransactions = (params?: Record<string, string | number | undefined>): Promise<any> => {
  const qs = params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && String(v) !== '').map(([k, v]) => [k, String(v)])).toString()}` : '';
  return apiFetch(API_BASE, `/api/demo/transactions${qs}`);
};
export const getDemoTransactionDetail = (id: string): Promise<any> => apiFetch(API_BASE, `/api/demo/transactions/${encodeURIComponent(id)}`);
export const getDemoDailyReport = (date?: string): Promise<any> => apiFetch(API_BASE, `/api/demo/daily-report${date ? `?date=${encodeURIComponent(date)}` : ''}`);
export const placeDemoOrder = (data: Record<string, any>): Promise<any> =>
  apiFetch(tradeProxyBase(), '/api/trade/demo/order', { method: 'POST', body: JSON.stringify(data) });
export const cancelDemoOrder = (orderId: string): Promise<any> =>
  apiFetch(API_BASE, '/api/demo/order/cancel', { method: 'POST', body: JSON.stringify({ orderId }) });
export const squareOffDemoPosition = (symbol: string, product = 'MIS'): Promise<any> =>
  apiFetch(API_BASE, '/api/demo/position/squareoff', { method: 'POST', body: JSON.stringify({ symbol, product }) });
export const addDemoFunds = (amount: number): Promise<any> =>
  apiFetch(API_BASE, '/api/demo/funds/add', { method: 'POST', body: JSON.stringify({ amount }) });
export const withdrawDemoFunds = (amount: number): Promise<any> =>
  apiFetch(API_BASE, '/api/demo/funds/withdraw', { method: 'POST', body: JSON.stringify({ amount }) });
export const updateDemoLtp = (updates: { symbol: string; ltp: number }[]): Promise<any> =>
  apiFetch(tradeProxyBase(), '/api/trade/demo/ltp', { method: 'POST', body: JSON.stringify({ updates }) });

// ---- Order Engine (docs/engines/order-engine.md) ----
// The Order Engine page's ONLY route to a broker or to the paper store. Every
// response is canonical: one status vocabulary across Kotak / Shoonya / Dummy,
// plus the real-time feed provenance so the page can never imply that live
// market data is flowing when it is not.
export type CanonicalOrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'TRIGGER_PENDING'
  | 'PARTIALLY_FILLED'
  | 'COMPLETE'
  | 'REJECTED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface CanonicalOrder {
  orderId: string;
  symbol: string;
  token: string;
  terminal: string;
  broker: string;
  isPaper: boolean;
  side: string;
  product: string;
  orderType: string;
  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  price: number;
  triggerPrice: number;
  averagePrice: number;
  orderValue: number;
  status: CanonicalOrderStatus;
  rawStatus: string;
  working: boolean;
  executed: boolean;
  reason: string;
  waitingReason: string;
  awaitingLtp: boolean;
  source: string;
  basketId?: string | null;
  correlationId?: string;
  charges: number;
  placedAt: string;
}

export interface MarketDataStatus {
  liveFeedReceiving: boolean;
  ticksPerSecond: number;
  latestTickCount: number;
  lastTickAt?: string | null;
  feedState: string;
  source: string;
  message: string;
  paperFeed?: {
    running: boolean;
    browserDependent: boolean;
    pendingInstruments: number;
    subscribedTokens: number;
    upstreamTicksPerSecond: number;
    counters?: Record<string, number>;
  };
}

export interface OrderEngineState {
  ok: boolean;
  engine: string;
  terminal: string;
  broker: string;
  isPaper: boolean;
  connected: boolean;
  capabilities: Record<string, any>;
  states: { working: string[]; executed: string[]; rejected: string[]; cancelled: string[] };
  marketData: MarketDataStatus;
}

export interface OrderEngineOrdersResponse {
  ok: boolean;
  terminal: string;
  broker?: string;
  isPaper?: boolean;
  connected: boolean;
  orders: CanonicalOrder[];
  counts: Record<string, number>;
  total: number;
  message?: string;
  marketData: MarketDataStatus;
}

export interface OrderEngineActionResult {
  ok: boolean;
  accepted?: boolean;
  working?: boolean;
  status?: string;
  orderId?: string | null;
  error?: { code?: string; message?: string };
  reasons?: string[];
  order?: CanonicalOrder | null;
  marketData?: MarketDataStatus;
}

const ORDER_ENGINE_BASE = API_BASE;

export const getOrderEngineState = (opts?: RequestInit & { timeoutMs?: number }): Promise<OrderEngineState> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/order-engine/state', opts);

export const getOrderEngineOrders = (terminal?: string, opts?: RequestInit & { timeoutMs?: number }): Promise<OrderEngineOrdersResponse> =>
  apiFetch(ORDER_ENGINE_BASE, `/api/order-engine/orders${terminal ? `?terminal=${encodeURIComponent(terminal)}` : ''}`, opts);

export const getOrderEngineHistory = (terminal?: string, limit = 200): Promise<OrderEngineOrdersResponse> =>
  apiFetch(ORDER_ENGINE_BASE, `/api/order-engine/history${terminal ? `?terminal=${encodeURIComponent(terminal)}` : ''}&limit=${limit}`);

export interface EngineOrderIntent {
  exchange?: string;
  exchange_segment?: string;
  token?: string;
  symbol: string;
  trading_symbol?: string;
  transaction_type: string;
  product: string;
  order_type: string;
  quantity: string | number;
  price?: string | number;
  trigger_price?: string | number;
  validity?: string;
  source?: string;
  basket_id?: string | null;
  /**
   * The live price the ticket is ALREADY rendering for this instrument. Sent
   * only when genuinely observed — the engine falls back to the backend's own
   * tick buffer and parks the order if neither has a price, so an order is
   * never filled from an invented number.
   */
  expected_ltp?: string | number;
}

export const placeEngineOrder = (intent: EngineOrderIntent): Promise<OrderEngineActionResult> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/order-engine/place', {
    method: 'POST',
    body: JSON.stringify(intent),
  });

export const cancelEngineOrder = (orderId: string, reason = ''): Promise<OrderEngineActionResult> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/order-engine/cancel', {
    method: 'POST',
    body: JSON.stringify({ order_id: orderId, reason }),
  });

export const modifyEngineOrder = (
  orderId: string,
  changes: { quantity?: string | number; price?: string | number; trigger_price?: string | number },
): Promise<OrderEngineActionResult> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/order-engine/modify', {
    method: 'POST',
    body: JSON.stringify({ order_id: orderId, ...changes }),
  });
export const resetDemoAccount = (startingBalance = 100000): Promise<any> =>
  apiFetch(API_BASE, '/api/demo/reset', { method: 'POST', body: JSON.stringify({ startingBalance }) });

/** Connect / ensure-ready the Dummy (paper) terminal from the frontend. */
export const connectDummyTerminal = (): Promise<any> =>
  apiFetch(API_BASE, '/api/demo/connect', { method: 'POST' });

// ---------------------------------------------------------------------------
// Per-broker ORDER ENGINE pages — Dummy / Kotak / Shoonya / Settings
// ---------------------------------------------------------------------------

/** Terminal-specific block shapes (kept loose — the page renders defensively). */
export interface OrderEngineTerminalDetail {
  ok: boolean;
  terminal: string;
  broker: string;
  brokerName?: string;
  isPaper: boolean;
  engineKind: 'paper' | 'sdk' | string;
  enginePath: string;
  sdk: { sdk?: string; module?: string };
  connected: boolean;
  capabilities: Record<string, any>;
  marketData: MarketDataStatus;
  orders: CanonicalOrder[];
  counts: Record<string, number>;
  total: number;
  message?: string;
  /** dummy-only: real paper-engine verification (producers, fills, feeds). */
  paper?: {
    store?: string;
    producers?: Record<string, number>;
    byStatus?: Record<string, number>;
    totalDistinct?: number;
    placedLast24h?: number;
    filledLast24h?: number;
    restingNow?: number;
    fillSources?: Record<string, number>;
    lastFill?: Record<string, any> | null;
    lastResting?: Record<string, any> | null;
    account?: Record<string, any>;
    prefs?: Record<string, any>;
    feed?: Record<string, any>;
  };
  /** kotak-only: Kotak WS#2 order-feed supervisor status. */
  orderFeed?: Record<string, any>;
  /** shoonya-only: OAuth availability + url. */
  oauth?: { available: boolean; url?: string | null; error?: string };
}

export const getOrderEngineTerminalDetail = (
  terminal: 'dummy' | 'kotak' | 'shoonya',
  opts?: RequestInit & { timeoutMs?: number; summary?: boolean },
): Promise<OrderEngineTerminalDetail> =>
  apiFetch(
    ORDER_ENGINE_BASE,
    `/api/order-engine/engine/${terminal}${opts?.summary !== false ? '?summary=1' : ''}`,
    opts,
  );

export interface OrderEngineSettingsResponse {
  ok: boolean;
  prefs: Record<string, any>;
  modeLock: Record<string, any>;
  engineRuntime: Record<string, any>;
  paperModel: Record<string, any>;
}

export const getOrderEngineSettings = (): Promise<OrderEngineSettingsResponse> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/order-engine/settings');

/** Apply paper-engine prefs (unknown keys dropped server-side). */
export const saveOrderEngineSettings = (prefs: Record<string, unknown>): Promise<any> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/order-engine/settings', {
    method: 'POST',
    body: JSON.stringify({ prefs }),
  });

/** Order Engine facade settings schema (engines plane — real persisted keys). */
export const getOrderEngineFacadeConfig = (): Promise<any> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/services/engines/order_engine/config');

export const updateOrderEngineFacadeConfig = (updates: Record<string, unknown>): Promise<any> =>
  apiFetch(ORDER_ENGINE_BASE, '/api/services/engines/order_engine/config', {
    method: 'PATCH',
    body: JSON.stringify({ settings: updates }),
  });
