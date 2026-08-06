const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8000';

async function apiFetch(base: string, path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers as Record<string, string> || {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return res.json();
}

// ---- System / Health ----
export const getNodeHealth = (): Promise<any> => apiFetch(API_BASE, '/health');
export const getSystemStatus = (): Promise<any> => apiFetch(API_BASE, '/api/system');
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
export const searchStockInfo = (searchText: string): Promise<any> =>
  apiFetch(API_BASE, '/api/stocks/search', { method: 'POST', body: JSON.stringify({ search_text: searchText }) });

// ---- Settings ----
export const getSettings = (): Promise<any> => apiFetch(API_BASE, '/api/settings');
export const updateSetting = (key: string, value: any): Promise<any> =>
  apiFetch(API_BASE, `/api/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
export const resetSetting = (key: string): Promise<any> =>
  apiFetch(API_BASE, `/api/settings/${key}/reset`, { method: 'POST' });
export const resetAllSettings = (): Promise<any> =>
  apiFetch(API_BASE, '/api/settings/reset-all', { method: 'POST' });

// ---- Downloads ----
export const getDownloadUrl = (params: Record<string, string>): string => {
  const qs = new URLSearchParams(params).toString();
  return `${API_BASE}/api/downloads?${qs}`;
};

// ---- Watchlist ----
export const getWatchlist = (): Promise<any> => apiFetch(API_BASE, '/api/watchlist');
export const addToWatchlist = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/watchlist', { method: 'POST', body: JSON.stringify(data) });
export const removeFromWatchlist = (symbol: string): Promise<any> =>
  apiFetch(API_BASE, `/api/watchlist/${symbol}`, { method: 'DELETE' });
export const toggleWatchlistFavorite = (symbol: string): Promise<any> =>
  apiFetch(API_BASE, `/api/watchlist/${symbol}/favorite`, { method: 'PATCH' });

// ---- Notifications ----
export const getNotifications = (params = ''): Promise<any> => apiFetch(API_BASE, `/api/notifications${params}`);
export const markNotificationRead = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/notifications/read/${id}`, { method: 'PUT' });
export const markAllNotificationsRead = (): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications/read-all', { method: 'PUT' });
export const deleteNotification = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/notifications/${id}`, { method: 'DELETE' });
export const clearAllNotifications = (): Promise<any> =>
  apiFetch(API_BASE, '/api/notifications', { method: 'DELETE' });

// ---- Trading (direct to Python → Kotak SDK) ----
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
export const searchScrip = (exchange: string, searchText: string): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/search', { method: 'POST', body: JSON.stringify({ exchange, search_text: searchText }) });
export const getQuote = (tokens: Record<string, any>[], quoteType = 'ltp', isIndex = false): Promise<any> =>
  apiFetch(API_BASE, '/api/trading/quote', { method: 'POST', body: JSON.stringify({ instrument_tokens: tokens, quote_type: quoteType, isIndex }) });

// ---- Type definitions ----
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
  status: string;
  orderId: string | null;
  error: string | null;
};

export type Basket = {
  _id: string;
  name: string;
  orders: BasketOrder[];
  status: string;
  cancelOnFill: boolean;
  createdAt: string;
  updatedAt: string;
};

// ---- Session / Python service ----
export const getPythonHealth = (): Promise<any> => apiFetch(API_BASE, '/health');
export const getPythonStatus = (): Promise<any> => apiFetch(API_BASE, '/status');
export const triggerLogin = (): Promise<any> => apiFetch(API_BASE, '/login', { method: 'POST' });
export const triggerLogout = (): Promise<any> => apiFetch(API_BASE, '/logout', { method: 'POST' });
export const getPythonSession = (): Promise<any> => apiFetch(API_BASE, '/session');

// ---- Live Ticks ----
export const getRecentTicks = (limit = 50, symbol = ''): Promise<any> =>
  apiFetch(API_BASE, `/api/ticks/recent?limit=${limit}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`);
export const getTickStreamUrl = (): string => `${API_BASE}/api/ticks/stream`;

// ---- Baskets ----
export const getBaskets = (): Promise<any> => apiFetch(API_BASE, '/api/baskets');
export const createBasket = (data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, '/api/baskets', { method: 'POST', body: JSON.stringify(data) });
export const updateBasket = (id: string, data: Record<string, any>): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteBasket = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}`, { method: 'DELETE' });
export const pushBasket = (id: string): Promise<any> =>
  apiFetch(API_BASE, `/api/baskets/${id}/push`, { method: 'POST' });

// ---- Gainers/Losers ----
export const getGainersLosers = (filter = 0, limit = 20): Promise<any> =>
  apiFetch(API_BASE, `/api/statistics/gainers-losers?filter=${filter}&limit=${limit}`);

// ---- System extended ----
export const getMongoStats = (): Promise<any> => apiFetch(API_BASE, '/api/system/mongo-stats');
export const clearLogs = (category?: string): Promise<any> =>
  apiFetch(API_BASE, '/api/system/logs/clear', { method: 'POST', body: JSON.stringify({ category }) });
export const getDownloadHistory = (): Promise<any> => apiFetch(API_BASE, '/api/system/download-history');
export const getTradingDayStats = (date?: string): Promise<any> =>
  apiFetch(API_BASE, `/api/system/trading-day-stats${date ? `?date=${date}` : ''}`);
export const getTradingHistory = (range = 'daily', limit = 30): Promise<any> =>
  apiFetch(API_BASE, `/api/system/trading-history?range=${range}&limit=${limit}`);
