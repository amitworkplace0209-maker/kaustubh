/**
 * Canonical instrument-search contract.
 *
 * Every instrument search in the app must read its data from here. The Search
 * Engine (`python-service/core/engines/search_engine.py`, exposed at
 * `GET /api/search`) is the single authority for instrument metadata and live
 * market state; this module is the single frontend shape for it.
 *
 * Rules this module enforces:
 *  - No invented values. A field the backend did not supply stays `null` and is
 *    paired with the backend's own status (`liveStatus`, `marginStatus`).
 *  - No per-consumer field aliasing. Legacy endpoints (`/api/stocks/search`,
 *    `/api/trading/search`, `/api/market-watch/search`) return different key
 *    names for the same facts; `normalizeSearchResult` folds them into the one
 *    canonical shape so no consumer has to re-implement the mapping.
 *  - No per-consumer debounce/abort logic. That lives in
 *    `hooks/use-instrument-search.ts` and the shared constants below.
 *
 * This module is deliberately import-free so the contract can be unit-tested in
 * isolation. The network call lives in `lib/instrument-search-client.ts`.
 */

/** Live-state status vocabulary (docs/engines/search-engine.md §15). */
export type LiveStatus = 'LIVE' | 'STALE' | 'UNAVAILABLE';

/**
 * Margin status vocabulary. `REQUIRES_ORDER_CONTEXT` is reported when the value
 * genuinely depends on order parameters (product / order type / quantity /
 * price) that the search request did not supply. Search never estimates it.
 */
export type MarginStatus =
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'REQUIRES_ORDER_CONTEXT';

/** Error codes the Search Engine may return (docs/engines/search-engine.md §21). */
export type SearchErrorCode =
  | 'EMPTY_QUERY'
  | 'SEARCH_INVALID_SCOPE'
  | 'SEARCH_INDEX_UNAVAILABLE'
  | null;

/** The one instrument shape. `null` means "not available", never "zero". */
export interface CanonicalInstrument {
  type: 'stock' | string;
  id?: string;

  // --- identity (canonical instrument master) ---
  symbol: string;
  tradingSymbol: string;
  name: string;
  token: string;
  exchange: string;
  exchangeSegment: string;
  instrumentType: string;
  series?: string;
  isin: string;
  lotSize: number | null;
  tickSize: number | null;

  // --- live market state (canonical tick store) ---
  ltp: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  timestamp: string | null;
  tickAgeSeconds: number | null;
  liveStatus: LiveStatus;
  /** Canonical price source id ('websocket' | 'broker' | 'last_close'). */
  source: string | null;

  // --- margin (Margin Engine / authoritative provider) ---
  oneQtyMargin: number | null;
  marginStatus: MarginStatus;
}

export interface CanonicalSearchResponse {
  query: string;
  normalized: string;
  results: CanonicalInstrument[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  scopes: string[];
  tookMs: number;
  errorCode: SearchErrorCode;
}

// ---- shared search constants (single source of truth) ----
// These used to live in `lib/order-workspace.ts`, which made them invisible to
// the other fifteen search call sites. They describe the Search Engine, not the
// Orders workspace, so they are owned here; `order-workspace` re-exports them.

/** Below this length a query is not sent — keeps one keystroke from hitting the API. */
export const SEARCH_MIN_CHARS = 2;
/** One request per pause in typing (docs/engines/search-engine.md §18).
 *  Deliberately short: a warm /api/search round trip is ~100ms and the response
 *  cache absorbs repeats, so a longer wait only adds visible lag between the
 *  keystroke and the suggestion list. The stale-response guard (abort +
 *  monotonic sequence) — not the debounce — is what keeps typing safe. */
export const SEARCH_DEBOUNCE_MS = 120;
/** Dropdown suggestions (spec §17: 5–10). */
export const SEARCH_SUGGESTION_LIMIT = 8;
/** Hard ceiling for a single round-trip, so the UI can fail honestly. */
export const SEARCH_MAX_WAIT_MS = 8000;

/** True when the query is long enough to hit the search API. */
export function shouldSearch(query: string, minChars: number = SEARCH_MIN_CHARS): boolean {
  return query.trim().length >= minChars;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function liveStatusOf(value: unknown): LiveStatus {
  const s = String(value ?? '').toUpperCase();
  if (s === 'LIVE' || s === 'STALE') return s;
  return 'UNAVAILABLE';
}

function marginStatusOf(value: unknown): MarginStatus {
  const s = String(value ?? '').toUpperCase();
  if (
    s === 'AVAILABLE' ||
    s === 'STALE' ||
    s === 'REQUIRES_ORDER_CONTEXT'
  ) {
    return s;
  }
  return 'UNAVAILABLE';
}

/**
 * Fold any search-endpoint row into the canonical shape.
 *
 * Accepts the canonical `/api/search` contract plus the legacy aliases used by
 * `/api/stocks/search`, `/api/trading/search{,‑local}` and
 * `/api/market-watch/search` so those callers can migrate without a flag day.
 * The backend's own status always wins over any inference made here.
 */
export function normalizeSearchResult(raw: Record<string, any> | null | undefined): CanonicalInstrument {
  const r = raw ?? {};
  const circuit = r.circuit ?? {};
  const exchangeSegment = str(r.exchangeSegment ?? r.pExchSeg ?? r.exSeg ?? r.exchange_segment);

  return {
    type: str(r.type, 'stock'),
    id: str(r.id) || undefined,

    symbol: str(r.symbol ?? r.pSymbolName ?? r.tradingSymbol),
    tradingSymbol: str(r.tradingSymbol ?? r.pTrdSymbol ?? r.trdSym ?? r.symbol),
    name: str(r.name ?? r.companyName ?? r.pDesc),
    token: str(r.token ?? r.instrument_token ?? r.instrumentToken ?? r.tok),
    exchange: str(r.exchange ?? r.pExchSeg, 'NSE'),
    exchangeSegment: exchangeSegment || str(r.exchange, 'nse_cm'),
    instrumentType: str(r.instrumentType ?? r.pInstType ?? r.instType),
    series: str(r.series ?? r.pSeries) || undefined,
    isin: str(r.isin),
    lotSize: num(r.lotSize ?? r.pLotSize),
    tickSize: num(r.tickSize ?? r.pTicksize),

    ltp: num(r.ltp ?? r.last_price ?? r.lastTradedPrice),
    prevClose: num(r.prevClose ?? r.previousClose ?? r.close ?? r.prev_close),
    change: num(r.change ?? r.netChange),
    changePct: num(r.changePct ?? r.changePercent ?? r.netChangePercent),
    volume: num(r.volume),
    bid: num(r.bid ?? r.bp),
    ask: num(r.ask ?? r.sp),
    spread: num(r.spread),
    upperCircuit: num(
      r.upperCircuit ?? r.upper_circuit ?? r.upper_circuit_limit ?? r.priceband_upper ?? circuit.upper,
    ),
    lowerCircuit: num(
      r.lowerCircuit ?? r.lower_circuit ?? r.lower_circuit_limit ?? r.priceband_lower ?? circuit.lower,
    ),
    timestamp: r.timestamp == null ? null : str(r.timestamp) || null,
    tickAgeSeconds: num(r.tickAgeSeconds ?? r.dataAgeSec ?? r.ageSeconds),
    liveStatus: liveStatusOf(r.liveStatus ?? r.dataStatus ?? r.status),
    source: r.source == null ? null : str(r.source) || null,

    oneQtyMargin: num(r.oneQtyMargin ?? r.margin),
    marginStatus: marginStatusOf(r.marginStatus),
  };
}

export function normalizeSearchResponse(raw: {
  query?: string;
  normalized?: string;
  results?: unknown[] | null;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  scopes?: string[] | null;
  tookMs?: number;
  errorCode?: string | null;
} | null | undefined): CanonicalSearchResponse {
  const rows = Array.isArray(raw?.results) ? raw!.results : [];
  return {
    query: str(raw?.query),
    normalized: str(raw?.normalized),
    results: rows.map((row) => normalizeSearchResult(row as Record<string, any>)),
    total: typeof raw?.total === 'number' ? raw.total : rows.length,
    hasMore: raw?.hasMore === true,
    nextCursor: raw?.nextCursor ?? null,
    scopes: Array.isArray(raw?.scopes) ? raw!.scopes : ['stocks'],
    tookMs: typeof raw?.tookMs === 'number' ? raw.tookMs : 0,
    errorCode: (raw?.errorCode ?? null) as SearchErrorCode,
  };
}

/** Stable identity for an instrument, used for dedupe and selection. */
export function instrumentKey(instrument: CanonicalInstrument): string {
  return instrument.token
    ? `${instrument.exchange}:${instrument.token}`
    : `${instrument.exchange}:${instrument.symbol}`;
}
