import assert from 'node:assert/strict';
import test from 'node:test';

import {
  instrumentKey,
  normalizeSearchResponse,
  normalizeSearchResult,
  shouldSearch,
  type CanonicalInstrument,
} from '../lib/instrument-search.ts';

const CANONICAL_ROW = {
  type: 'stock',
  id: 'NSE:11536',
  symbol: 'TCS',
  tradingSymbol: 'TCS-EQ',
  name: 'TATA CONSULTANCY SERV LT',
  token: '11536',
  exchange: 'NSE',
  exchangeSegment: 'nse_cm',
  instrumentType: 'EQ',
  series: 'EQ',
  isin: 'INE467B01029',
  lotSize: 1,
  tickSize: 0.05,
  ltp: 2072.0,
  prevClose: 2032.4,
  change: 39.6,
  changePct: 1.95,
  volume: 2011659,
  bid: 2071.6,
  ask: 2072.0,
  spread: 0.4,
  upperCircuit: 2235.6,
  lowerCircuit: 1829.2,
  timestamp: '2026-09-30T04:15:00+00:00',
  tickAgeSeconds: 0.4,
  liveStatus: 'LIVE',
  oneQtyMargin: 412.5,
  marginStatus: 'AVAILABLE',
};

test('canonical rows pass through unchanged', () => {
  const r = normalizeSearchResult(CANONICAL_ROW);
  assert.equal(r.symbol, 'TCS');
  assert.equal(r.token, '11536');
  assert.equal(r.name, 'TATA CONSULTANCY SERV LT');
  assert.equal(r.exchangeSegment, 'nse_cm');
  assert.equal(r.ltp, 2072.0);
  assert.equal(r.upperCircuit, 2235.6);
  assert.equal(r.lowerCircuit, 1829.2);
  assert.equal(r.liveStatus, 'LIVE');
  assert.equal(r.marginStatus, 'AVAILABLE');
  assert.equal(r.oneQtyMargin, 412.5);
});

test('missing market data stays null and never becomes zero', () => {
  const r = normalizeSearchResult({ symbol: 'TCS', token: '11536', exchange: 'NSE' });
  assert.equal(r.ltp, null);
  assert.equal(r.change, null);
  assert.equal(r.changePct, null);
  assert.equal(r.upperCircuit, null);
  assert.equal(r.lowerCircuit, null);
  assert.equal(r.oneQtyMargin, null);
  assert.notEqual(r.ltp as unknown as number, 0);
  assert.equal(r.liveStatus, 'UNAVAILABLE');
  assert.equal(r.marginStatus, 'UNAVAILABLE');
});

test('null and empty-string market values are treated as unavailable', () => {
  const r = normalizeSearchResult({ ...CANONICAL_ROW, ltp: null, changePct: '', volume: undefined });
  assert.equal(r.ltp, null);
  assert.equal(r.changePct, null);
  assert.equal(r.volume, null);
});

test('non-numeric market values do not produce NaN', () => {
  const r = normalizeSearchResult({ ...CANONICAL_ROW, ltp: 'N/A', volume: 'abc', tickAgeSeconds: 'x' });
  assert.equal(r.ltp, null);
  assert.equal(r.volume, null);
  assert.equal(r.tickAgeSeconds, null);
});

test('legacy stocks-search aliases fold into the canonical shape', () => {
  const r = normalizeSearchResult({
    pSymbolName: 'TCS',
    pTrdSymbol: 'TCS-EQ',
    pDesc: 'Tata Consultancy Services Ltd',
    instrument_token: 11536,
    pExchSeg: 'nse_cm',
    pInstType: 'EQ',
    pLotSize: 1,
    pTicksize: 0.05,
    last_price: 2072,
    prev_close: 2032.4,
    netChange: 39.6,
    netChangePercent: 1.95,
    priceband_upper: 2235.6,
    priceband_lower: 1829.2,
  });
  assert.equal(r.symbol, 'TCS');
  assert.equal(r.token, '11536');
  assert.equal(r.name, 'Tata Consultancy Services Ltd');
  assert.equal(r.exchangeSegment, 'nse_cm');
  assert.equal(r.ltp, 2072);
  assert.equal(r.change, 39.6);
  assert.equal(r.changePct, 1.95);
  assert.equal(r.upperCircuit, 2235.6);
  assert.equal(r.lowerCircuit, 1829.2);
});

test('nested circuit shape is accepted', () => {
  const r = normalizeSearchResult({
    symbol: 'TCS', token: '1', exchange: 'NSE',
    circuit: { upper: 110, lower: 90 },
  });
  assert.equal(r.upperCircuit, 110);
  assert.equal(r.lowerCircuit, 90);
});

test('numeric strings become numbers', () => {
  const r = normalizeSearchResult({ ...CANONICAL_ROW, ltp: '2072.0', lotSize: '10' });
  assert.equal(r.ltp, 2072);
  assert.equal(r.lotSize, 10);
});

test('REQUIRES_ORDER_CONTEXT margin status survives normalization', () => {
  const r = normalizeSearchResult({
    symbol: 'TCS', token: '11536', exchange: 'NSE',
    oneQtyMargin: null, marginStatus: 'REQUIRES_ORDER_CONTEXT',
  });
  assert.equal(r.marginStatus, 'REQUIRES_ORDER_CONTEXT');
  assert.equal(r.oneQtyMargin, null);
});

test('unknown margin status degrades to UNAVAILABLE rather than inventing a value', () => {
  const r = normalizeSearchResult({ symbol: 'TCS', marginStatus: 'WEIRD', oneQtyMargin: 99 });
  assert.equal(r.marginStatus, 'UNAVAILABLE');
  assert.equal(r.oneQtyMargin, 99);
});

test('unknown live status degrades to UNAVAILABLE', () => {
  assert.equal(normalizeSearchResult({ liveStatus: 'banana' }).liveStatus, 'UNAVAILABLE');
  assert.equal(normalizeSearchResult({ status: 'NO_DATA' }).liveStatus, 'UNAVAILABLE');
});

test('STALE stays STALE and is not downgraded to live', () => {
  assert.equal(normalizeSearchResult({ ltp: 10, liveStatus: 'STALE' }).liveStatus, 'STALE');
});

test('exchange segment falls back to exchange and then nse_cm', () => {
  assert.equal(normalizeSearchResult({ exchange: 'NSE' }).exchangeSegment, 'NSE');
  assert.equal(normalizeSearchResult({}).exchangeSegment, 'nse_cm');
});

test('normalizeSearchResponse maps every row and preserves envelope fields', () => {
  const res = normalizeSearchResponse({
    query: 'tcs',
    normalized: 'tcs',
    results: [CANONICAL_ROW, { symbol: 'TCS', token: '2', exchange: 'NSE' }],
    total: 2,
    hasMore: true,
    nextCursor: '8',
    scopes: ['stocks'],
    tookMs: 3.5,
    errorCode: null,
  });
  assert.equal(res.results.length, 2);
  assert.equal(res.results[0].symbol, 'TCS');
  assert.equal(res.results[1].liveStatus, 'UNAVAILABLE');
  assert.equal(res.hasMore, true);
  assert.equal(res.nextCursor, '8');
  assert.equal(res.tookMs, 3.5);
  assert.equal(res.errorCode, null);
});

test('normalizeSearchResponse tolerates a missing or empty envelope', () => {
  const res = normalizeSearchResponse(null);
  assert.equal(res.results.length, 0);
  assert.equal(res.total, 0);
  assert.equal(res.hasMore, false);
  assert.deepEqual(res.scopes, ['stocks']);
  assert.equal(res.errorCode, null);
});

test('error codes are carried through for the UI to explain', () => {
  for (const code of ['SEARCH_INDEX_UNAVAILABLE', 'SEARCH_INVALID_SCOPE', 'EMPTY_QUERY'] as const) {
    const res = normalizeSearchResponse({ errorCode: code, results: [] });
    assert.equal(res.errorCode, code);
    assert.equal(res.results.length, 0);
  }
});

test('instrumentKey prefers token identity and falls back to symbol', () => {
  const withToken: CanonicalInstrument = normalizeSearchResult({ symbol: 'TCS', token: '11536', exchange: 'NSE' });
  assert.equal(instrumentKey(withToken), 'NSE:11536');
  const noToken = normalizeSearchResult({ symbol: 'TCS', exchange: 'NSE' });
  assert.equal(instrumentKey(noToken), 'NSE:TCS');
});

test('normalizeSearchResult survives null and undefined rows', () => {
  assert.equal(normalizeSearchResult(null).symbol, '');
  assert.equal(normalizeSearchResult(undefined).symbol, '');
});

test('shouldSearch gates short queries so one keystroke never hits the API', () => {
  assert.equal(shouldSearch(''), false);
  assert.equal(shouldSearch('t'), false);
  assert.equal(shouldSearch('  t  '), false);
  assert.equal(shouldSearch('tc'), true);
  assert.equal(shouldSearch('tcs'), true);
  assert.equal(shouldSearch('TCS'), true);
  assert.equal(shouldSearch('Tata Consultancy Services'), true);
});

test('shouldSearch honours a caller-supplied minimum', () => {
  assert.equal(shouldSearch('tcs', 4), false);
  assert.equal(shouldSearch('tcsx', 4), true);
});
