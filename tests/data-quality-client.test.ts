// ---- Data Quality same-origin client tests (020 redesign) ----
//
// Runs on plain node:  npx node --test tests/data-quality-client.test.ts
// Pure mapping + envelope contract. Imported via RELATIVE path so no tsconfig
// path aliasing is required outside Next.js.
//
// Contracts under test:
//   1. Every filter control reaches the backend query (no decorative params).
//   2. Empty / ALL / All values are omitted (backend defaults apply).
//   3. The `{ ok: true, ...payload }` proxy envelope is unwrapped.
//   4. The `{ ok: false, error }` envelope raises a typed error (honest
//      failure, never a silent empty payload).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DataQualityError,
  dqGet,
  dqParamsForFilters,
} from '../lib/data-quality-client.ts';

// ---------------------------------------------------------------------------
// filter mapping
// ---------------------------------------------------------------------------

test('all filter controls reach the backend query', () => {
  const p = dqParamsForFilters({
    hours: 24,
    symbol: 'reliance',
    exchange: 'BSE',
    segment: 'FO',
    dateISO: '2026-09-01',
    timeFrom: '09:15',
    timeTo: '15:30',
  });
  assert.equal(p.hours, 24);
  assert.equal(p.symbol, 'RELIANCE');
  assert.equal(p.exchange, 'BSE');
  assert.equal(p.segment, 'FO');
  assert.equal(p.date, '2026-09-01');
  assert.equal(p.time_from, '09:15');
  assert.equal(p.time_to, '15:30');
});

test('empty and wildcard values are omitted so backend defaults apply', () => {
  const p = dqParamsForFilters({
    hours: 0,
    symbol: '   ',
    exchange: 'ALL',
    segment: 'All',
    dateISO: '',
    timeFrom: '',
    timeTo: '',
  });
  assert.deepEqual(p, {});
});

test('symbol is trimmed and uppercased', () => {
  const p = dqParamsForFilters({
    hours: 24,
    symbol: '  tcs  ',
    exchange: 'ALL',
    segment: 'All',
    dateISO: '',
    timeFrom: '',
    timeTo: '',
  });
  assert.equal(p.symbol, 'TCS');
});

// ---------------------------------------------------------------------------
// envelope contract (fetch stubbed)
// ---------------------------------------------------------------------------

function stubFetch(body: unknown, ok = true, status = 200) {
  (globalThis as any).fetch = async () => ({
    ok,
    status,
    json: async () => body,
  });
}

test('ok envelope is unwrapped without the ok flag', async () => {
  stubFetch({ ok: true, status: 'LIVE', totals: { totalTicks: 5 } });
  const out = await dqGet<{ status: string; totals: { totalTicks: number } }>('summary');
  assert.equal((out as any).ok, undefined);
  assert.equal(out.status, 'LIVE');
  assert.equal(out.totals.totalTicks, 5);
});

test('error envelope raises a typed DataQualityError', async () => {
  stubFetch({ ok: false, error: 'Data quality service unavailable', status: 502 }, false, 502);
  await assert.rejects(() => dqGet('summary'), DataQualityError);
});

test('query params are encoded into the same-origin URL', async () => {
  let seenUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await dqGet('symbols', { hours: 24, symbol: 'RELIANCE', limit: 120 });
  assert.match(seenUrl, /^\/api\/data-quality\/symbols\?/);
  assert.match(seenUrl, /hours=24/);
  assert.match(seenUrl, /symbol=RELIANCE/);
  assert.match(seenUrl, /limit=120/);
});
