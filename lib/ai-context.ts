/**
 * Context builders for local-AI analysis.
 *
 * Rule: the model receives **only engine-owned fields**. Nothing is derived,
 * estimated or filled in here. Missing values become `null` so the model can
 * say "not available" instead of inventing a number. This is the client-side
 * half of the "no fake data" contract; the bridge enforces the other half in
 * its system prompt.
 *
 * Pure functions only — no React, no fetch, no browser APIs — so they can be
 * unit-tested by `node --test`.
 */

type Json = Record<string, unknown>;

const RECORD_FIELDS = [
  'symbol',
  'token',
  'name',
  'exchange',
  'exchangeSegment',
  'ltp',
  'previousClose',
  'change',
  'changePercent',
  'volume',
  'vwap',
  'open',
  'dayHigh',
  'dayLow',
  'upperCircuit',
  'lowerCircuit',
  'circuitDistanceUpperPct',
  'circuitDistanceLowerPct',
  'circuitDistancePct',
  'circuitBandPct',
  'circuitStatus',
  'marginValue',
  'marginMultiplier',
  'marginStatus',
  'intradayStatus',
  'stockState',
  'classification',
  'status',
  'dataQuality',
  'dataAgeSec',
  'lastTickAt',
  'tickCount',
  'eligibilityStatus',
  'blockReason',
  'subscriptionStatus',
  'fiveMinPercent',
  'tenMinPercent',
  'change_5m',
  'change_5m_pct',
  'change_10m',
  'change_10m_pct',
  'change_15m',
  'change_15m_pct',
  'change_30m',
  'change_30m_pct',
  'change_1h',
  'change_1h_pct',
] as const;

const QUOTE_FIELDS = [
  'available',
  'ltp',
  'open',
  'high',
  'low',
  'prevClose',
  'volume',
  'changePercent',
  'upperCircuit',
  'lowerCircuit',
  'lastTickAt',
  'tickAgeSec',
  'source',
  'quoteTs',
  'circuitPercent',
] as const;

const CIRCUIT_FIELDS = [
  'upperCircuit',
  'lowerCircuit',
  'status',
  'distanceToUpperPct',
  'distanceToLowerPct',
  'isUpperCircuitHit',
  'isLowerCircuitHit',
  'isNearUpperCircuit',
  'isNearLowerCircuit',
  'circuitDataAvailable',
  'circuitReason',
] as const;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keepNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function keepValue(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function pick(source: unknown, fields: readonly string[]): Json {
  const out: Json = {};
  if (!isObject(source)) return out;
  for (const field of fields) {
    if (!(field in source)) continue;
    const value = keepValue(source[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

function depthSide(value: unknown): { price: number | null; quantity: number | null }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((level) => {
    if (!isObject(level)) return { price: null, quantity: null };
    return {
      price: keepNumber(level.price),
      quantity: keepNumber(level.quantity),
    };
  });
}

/**
 * Build a compact, real-fields-only context for one Market Watch symbol.
 *
 * Accepts the response of `GET /api/market-watch/symbol/{symbolOrToken}`.
 */
export function buildMarketWatchContext(detail: unknown): Json {
  const root = isObject(detail) ? detail : {};
  const record = pick(root.record, RECORD_FIELDS);
  const quote = pick(root.quote, QUOTE_FIELDS);
  const circuit = pick(root.circuit, CIRCUIT_FIELDS);
  const state = isObject(root.state)
    ? {
        status: keepValue(root.state.status) ?? null,
        dataAgeSec: keepNumber(root.state.dataAgeSec),
        intradayEligible: keepValue(root.state.intradayEligible) ?? null,
        priceSource: keepValue(root.state.priceSource) ?? null,
      }
    : {};

  const depthSource = isObject(root.depth) ? root.depth : {};
  const depth = {
    source: keepValue(depthSource.source) ?? null,
    available: keepValue(depthSource.available) ?? null,
    buy: depthSide(depthSource.buy),
    sell: depthSide(depthSource.sell),
  };

  return {
    source: 'market_watch_engine',
    asOf: keepValue(root.generatedAt) ?? null,
    symbol: keepValue(root.symbol) ?? record.symbol ?? null,
    token: keepValue(root.token) ?? record.token ?? null,
    tradingDate: keepValue(root.tradingDate) ?? null,
    feedState: keepValue(root.feedState) ?? null,
    state,
    record,
    quote,
    circuit,
    depth,
  };
}

/**
 * Build a context for a Market Watch board (top gainers/losers/etc.).
 * Rows are capped at 20 and reduced to the same engine-owned quote fields.
 */
export function buildMarketWatchBoardContext(boardName: string, rows: unknown): Json {
  const list = Array.isArray(rows) ? rows.slice(0, 20) : [];
  return {
    source: 'market_watch_engine',
    board: String(boardName || ''),
    rowCount: Array.isArray(rows) ? rows.length : 0,
    rows: list.map((row) => pick(row, RECORD_FIELDS)),
  };
}

/**
 * Build a context for the AI Suggestions page. The numeric series and the
 * deterministic engine suggestions are passed through unchanged; the small
 * summary is plain arithmetic over those same numbers.
 */
export function buildSuggestionSeriesContext(series: unknown, engineSuggestions: unknown): Json {
  const numbers = Array.isArray(series)
    ? series.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : [];
  const sample = numbers.slice(-120);
  const suggestions = Array.isArray(engineSuggestions)
    ? engineSuggestions
        .map((item) => {
          if (typeof item === 'string') return item;
          if (isObject(item) && typeof item.text === 'string') return item.text;
          return null;
        })
        .filter((item): item is string => Boolean(item))
    : [];

  const summary = sample.length
    ? {
        count: sample.length,
        first: sample[0],
        last: sample[sample.length - 1],
        min: Math.min(...sample),
        max: Math.max(...sample),
        mean: sample.reduce((sum, value) => sum + value, 0) / sample.length,
        last3Change: sample.length >= 3 ? sample[sample.length - 1] - sample[sample.length - 3] : null,
      }
    : null;

  return {
    source: 'khumbha_ai_suggestions',
    series: sample,
    truncated: numbers.length > sample.length,
    originalLength: numbers.length,
    summary,
    engineSuggestions: suggestions,
  };
}

/** Human-readable list of what was actually sent, for the UI's provenance chips. */
export function contextFields(context: Json): string[] {
  return Object.keys(context).filter((key) => context[key] !== null && context[key] !== undefined);
}
