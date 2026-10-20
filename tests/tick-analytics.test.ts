// ---- Tick Analytics pure helpers ----
//
// Locks the section contract (page <-> BFF <-> backend) and, above all, the
// HONESTY CONTRACT: an unmeasurable value must surface as null / em dash, and
// must NEVER be defaulted to 0 by a formatting helper. Also locks the
// realtime merge rule (a missing realtime field degrades to "stale", not "0").

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SECTIONS,
  ageSec,
  backendPath,
  dailyChartSeries,
  dailyRowStatus,
  duplicateTone,
  fmtBytes,
  fmtCompactNum,
  fmtIST,
  fmtISTTime,
  fmtNumber,
  fmtRate,
  honest,
  isSectionId,
  mergeLive,
  missingChips,
  num,
  periodChartSeries,
  persistenceTone,
  rangeSec,
  reportSummary,
  sectionQuery,
  sourceChips,
  statusLabel,
  statusTone,
  toMs,
  topSymbolSeries,
} from '../lib/tick-analytics.ts';

/* ------------------------------- section contract ------------------------ */

test('every section maps to a real backend path', () => {
  assert.equal(backendPath('summary'), '/api/data-saver/tick-analytics/summary');
  assert.equal(backendPath('daily', { days: 30 }), '/api/data-saver/tick-analytics/daily?days=30');
  assert.equal(backendPath('day', { date: '2026-10-01' }), '/api/data-saver/tick-analytics/daily/2026-10-01');
  assert.equal(
    backendPath('top', { date: '2026-10-01', limit: 15 }),
    '/api/data-saver/tick-analytics/top-symbols?date=2026-10-01&limit=15',
  );
  assert.equal(
    backendPath('symbolStats', { symbol: 'RELIANCE' }),
    '/api/data-saver/tick-analytics/symbol-stats/RELIANCE',
  );
  assert.equal(backendPath('report'), '/api/data-saver/tick-analytics/report');
  assert.equal(backendPath('reports', { days: 60 }), '/api/data-saver/tick-analytics/reports?days=60');
  assert.equal(
    backendPath('export', { date: '2026-10-01', format: 'csv' }),
    '/api/data-saver/tick-analytics/export?date=2026-10-01&format=csv',
  );
  assert.equal(backendPath('live'), '/api/data-saver/tick-analytics/state');
});

test('path params never leak into the query string', () => {
  const path = backendPath('day', { date: '2026-10-01' });
  assert.ok(!path.includes('?date='), 'date must travel in the path, not the query');
  const sym = backendPath('symbolStats', { symbol: 'A B', date: '2026-10-01' });
  assert.ok(sym.includes('/symbol-stats/A%20B'), 'symbol must be URL-encoded in the path');
  assert.ok(sym.includes('date=2026-10-01'), 'date is still a query param for symbol stats');
});

test('sectionQuery builds the BFF query and drops empty values', () => {
  assert.equal(sectionQuery('summary', {}), '?section=summary');
  assert.equal(sectionQuery('daily', { days: 30 }), '?section=daily&days=30');
  assert.equal(sectionQuery('top', { date: '', limit: 5, extra: undefined }), '?section=top&limit=5');
});

test('isSectionId accepts only known sections', () => {
  for (const s of SECTIONS) assert.equal(isSectionId(s), true);
  assert.equal(isSectionId('summary '), false);
  assert.equal(isSectionId('unknown'), false);
  assert.equal(isSectionId(42), false);
});

/* ------------------------------- primitives ------------------------------ */

test('rangeSec covers the offered ranges and falls back to 5 minutes', () => {
  assert.equal(rangeSec('1m'), 60);
  assert.equal(rangeSec('5m'), 300);
  assert.equal(rangeSec('15m'), 900);
  assert.equal(rangeSec('1h'), 3600);
  assert.equal(rangeSec('1d'), 86400);
  assert.equal(rangeSec('nonsense'), 300);
});

test('toMs normalises every timestamp shape and rejects junk', () => {
  assert.equal(toMs(1600000000000), 1600000000000);
  assert.equal(toMs(1600000000), 1600000000000);
  assert.equal(toMs('2026-10-01T09:15:00.000Z'), Date.parse('2026-10-01T09:15:00.000Z'));
  assert.equal(toMs({ $date: '2026-10-01T09:15:00.000Z' }), Date.parse('2026-10-01T09:15:00.000Z'));
  assert.equal(toMs('not a date'), null);
  assert.equal(toMs(undefined), null);
  assert.equal(toMs(null), null);
  assert.equal(toMs(Number.NaN), null);
});

test('num rejects non-finite input instead of coercing to zero', () => {
  assert.equal(num(5), 5);
  assert.equal(num('5'), 5);
  assert.equal(num(Number.NaN), null);
  assert.equal(num(Infinity), null);
  assert.equal(num(undefined), null);
  assert.equal(num('abc'), null);
});

test('honest renders unmeasurable values as an em dash, never 0', () => {
  assert.equal(honest(null), '—');
  assert.equal(honest(undefined), '—');
  assert.equal(honest(Number.NaN), '—');
  assert.equal(honest(0), '0', 'a genuine zero must still render as zero');
  assert.equal(honest(99.5, '%'), '99.5%', 'percentages must not round away precision');
  assert.equal(honest(1000), '1,000');
  assert.equal(honest(44.567), '44.57');
});

test('fmtNumber / fmtRate keep null as null', () => {
  assert.equal(fmtNumber(null), '—');
  assert.equal(fmtNumber(undefined), '—');
  assert.equal(fmtNumber(1234567), '12,34,567');
  assert.equal(fmtRate(null), '—');
  assert.equal(fmtRate(44.567), '44.57');
  assert.equal(fmtRate(910.4), '910');
});

test('fmtCompactNum and fmtBytes never emit NaN', () => {
  assert.equal(fmtCompactNum(null), '—');
  assert.equal(fmtCompactNum(0), '0');
  assert.equal(fmtCompactNum(1500), '1.50K');
  assert.equal(fmtCompactNum(2_500_000), '2.50M');
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.ok(!fmtBytes(Number.NaN).includes('NaN'));
});

test('IST formatting is timezone-stable and null-safe', () => {
  const ms = Date.parse('2026-10-01T04:00:00.000Z'); // 09:30 IST
  assert.equal(fmtISTTime(ms), '09:30:00');
  assert.equal(fmtIST(null), '—');
  assert.equal(fmtIST('garbage'), '—');
});

test('ageSec is clamped at zero and null when the timestamp is unknown', () => {
  const now = Date.parse('2026-10-01T04:00:00.000Z');
  assert.equal(ageSec('2026-10-01T03:59:55.000Z', now), 5);
  assert.equal(ageSec('2026-10-01T04:00:30.000Z', now), 0, 'future timestamps must not go negative');
  assert.equal(ageSec(null, now), null);
});

/* ------------------------------- honesty contract ------------------------ */

test('missingChips labels known reasons and passes unknown ones through', () => {
  assert.deepEqual(missingChips(null), []);
  assert.deepEqual(missingChips([]), []);
  const chips = missingChips(['ticksReceived', 'persistenceSuccessRate', 'weird_reason']);
  assert.deepEqual(chips.map((c) => c.key), ['ticksReceived', 'persistenceSuccessRate', 'weird_reason']);
  assert.equal(chips[0].label, 'TICKS RECEIVED');
  assert.equal(chips[1].label, 'PERSISTENCE SUCCESS RATE');
  assert.ok(chips[2].label.length > 0, 'unknown reasons must still render');
});

test('dailyRowStatus distinguishes backfilling from genuinely empty days', () => {
  const complete = { date: '2026-10-01', status: 'COMPLETE', counts: { storedDocs: 10 } };
  assert.equal(dailyRowStatus(complete), 'COMPLETE');
  assert.equal(dailyRowStatus({ ...complete, status: 'PARTIAL' }), 'PARTIAL');
  assert.equal(dailyRowStatus({ ...complete, status: 'NO_DATA' }), 'NO_DATA');

  // Still queued in the background backfill -> NOT "no data", NOT "0 ticks".
  assert.equal(dailyRowStatus(complete, ['2026-10-01']), 'BACKFILLING');

  // A row with no stored docs and no explicit status is NO_DATA, not 0.
  assert.equal(dailyRowStatus({ date: '2026-10-01' }), 'NO_DATA');
  assert.equal(dailyRowStatus({ date: '2026-10-01', counts: { storedDocs: 0 } }), 'NO_DATA');

  // No row at all: backfilling if days are pending, otherwise NO_DATA.
  assert.equal(dailyRowStatus(null, ['2026-10-01']), 'BACKFILLING');
  assert.equal(dailyRowStatus(undefined, []), 'NO_DATA');
});

test('a day with writer activity but no stored documents is PARTIAL, not empty', () => {
  const row = {
    date: '2026-10-01',
    status: 'PARTIAL',
    counts: { received: 15811, persisted: 0, failed: 0, storedDocs: 0 },
    ticks: { count: 0 },
    missing: ['tickTimeline', 'storedTickDocuments'],
  };
  assert.equal(dailyRowStatus(row), 'PARTIAL', 'zero stored docs must not collapse to NO_DATA');
  assert.equal(dailyRowStatus(row, ['2026-10-01']), 'BACKFILLING', 'queued wins');
  const chips = missingChips(row.missing);
  assert.deepEqual(chips.map((c) => c.label), ['TICK TIMELINE', 'STORED TICK DOCUMENTS']);
});

test('statusTone/statusLabel map the backend status vocabulary', () => {
  assert.equal(statusTone('COMPLETE'), 'success');
  assert.equal(statusTone('PARTIAL'), 'warning');
  assert.equal(statusTone('NO_DATA'), 'neutral');
  assert.equal(statusTone('UNAVAILABLE'), 'danger');
  assert.equal(statusTone(undefined), 'neutral');
  assert.equal(statusLabel('NO_DATA'), 'NO DATA');
  assert.equal(statusLabel('PARTIAL'), 'PARTIAL');
  assert.equal(statusLabel(''), 'UNKNOWN');
});

test('persistenceTone treats an unmeasured rate as neutral, not as 0%', () => {
  assert.equal(persistenceTone(null), 'neutral');
  assert.equal(persistenceTone(undefined), 'neutral');
  assert.equal(persistenceTone(Number.NaN), 'neutral');
  assert.equal(persistenceTone(100), 'success');
  assert.equal(persistenceTone(99.5), 'success');
  assert.equal(persistenceTone(97), 'warning');
  assert.equal(persistenceTone(50), 'danger');
});

test('duplicateTone thresholds are the documented ones', () => {
  assert.equal(duplicateTone(null), 'neutral');
  assert.equal(duplicateTone(0.5), 'success');
  assert.equal(duplicateTone(3), 'warning');
  assert.equal(duplicateTone(9), 'danger');
});

/* ------------------------------- chart series ---------------------------- */

test('dailyChartSeries reverses to chronological order and preserves nulls', () => {
  const series = dailyChartSeries([
    { date: '2026-10-03', ticks: { count: 300 } },
    { date: '2026-10-02', ticks: { count: null } },
    { date: '2026-10-01', ticks: { count: 100 } },
  ]);
  assert.deepEqual(series.map((p) => p.time), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(series.map((p) => p.value), [100, null, 300]);
});

test('dailyChartSeries falls back to persisted count and never invents 0', () => {
  const series = dailyChartSeries([{ date: '2026-10-01', counts: { persisted: 42 } }]);
  assert.deepEqual(series, [{ time: '2026-10-01', value: 42 }]);

  const empty = dailyChartSeries([{ date: '2026-10-01' }]);
  assert.deepEqual(empty, [{ time: '2026-10-01', value: null }]);

  assert.deepEqual(dailyChartSeries([]), []);
  assert.deepEqual(dailyChartSeries([{ noDate: true }]), []);
});

test('periodChartSeries keeps the backend label and null ticks', () => {
  const series = periodChartSeries([
    { label: '09:15-10:00', ticks: 16 },
    { label: '10:00-11:00', ticks: null },
  ]);
  assert.deepEqual(series, [
    { time: '09:15-10:00', value: 16 },
    { time: '10:00-11:00', value: null },
  ]);
});

test('topSymbolSeries maps symbol -> axis label', () => {
  const series = topSymbolSeries([
    { symbol: 'RELIANCE', ticks: 900 },
    { symbol: 'TCS', ticks: null },
  ]);
  assert.deepEqual(series, [
    { time: 'RELIANCE', value: 900 },
    { time: 'TCS', value: null },
  ]);
});

/* ------------------------------- report ---------------------------------- */

test('reportSummary is NO_DATA when there is no report at all', () => {
  const s = reportSummary(null);
  assert.equal(s.status, 'NO_DATA');
  assert.equal(s.complete, false);
  assert.equal(s.sectionCount, 0);
  assert.deepEqual(s.missing.map((m) => m.key), ['daily_document']);
});

test('reportSummary mirrors the backend status and lists missing metrics', () => {
  const complete = reportSummary({
    status: 'COMPLETE',
    missing: [],
    sections: { counts: {}, ticks: {}, persistence: {}, storage: {}, quality: {} },
  });
  assert.equal(complete.status, 'COMPLETE');
  assert.equal(complete.complete, true);
  assert.equal(complete.sectionCount, 5);
  assert.deepEqual(complete.missing, []);

  const partial = reportSummary({ status: 'PARTIAL', missing: ['persistenceSuccessRate'], sections: { counts: {} } });
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing.map((m) => m.key), ['persistenceSuccessRate']);
  assert.equal(partial.missing[0].label, 'PERSISTENCE SUCCESS RATE');

  // An unknown status must not be silently promoted to COMPLETE.
  assert.equal(reportSummary({ status: 'WEIRD', missing: [] }).status, 'NO_DATA');
});

test('sourceChips drops empty provenance instead of showing blank chips', () => {
  assert.deepEqual(sourceChips(null), []);
  assert.deepEqual(sourceChips(undefined), []);
  const chips = sourceChips({
    received: 'daily_summaries.totalTicks',
    persisted: null,
    empty: '',
    storedDocs: 'mongodb:ticks.count(ts-in-day)',
  });
  assert.deepEqual(chips.map((c) => c.label), ['RECEIVED', 'STORED DOCS']);
  assert.equal(chips[0].value, 'daily_summaries.totalTicks');
});

/* ------------------------------- realtime merge -------------------------- */

test('mergeLive never replaces a value with zero when the frame omits it', () => {
  const rest = { ticksReceived: 1000, persistenceSuccessPct: 99.5, symbols: 42, note: 'keep' };
  const merged = mergeLive(rest, { ticksReceived: 1200, tickRate: 44 });

  // Present realtime fields win.
  assert.equal((merged as any).ticksReceived, 1200);
  assert.equal((merged as any).tickRate, 44);
  // Absent realtime fields keep the REST value -- NOT 0, NOT undefined.
  assert.equal((merged as any).persistenceSuccessPct, 99.5);
  assert.equal((merged as any).symbols, 42);
  assert.equal((merged as any).note, 'keep');
});

test('mergeLive tolerates a missing realtime frame or missing snapshot', () => {
  const rest = { a: 1 };
  assert.deepEqual(mergeLive(rest, null), { a: 1 });
  assert.deepEqual(mergeLive(null, { a: 1 }), {});
  assert.deepEqual(mergeLive(undefined, undefined), {});
});

test('mergeLive drops explicit nulls/undefined from the realtime frame', () => {
  const rest = { a: 1, b: 2 };
  const merged = mergeLive(rest, { a: null, b: undefined, c: 3 }) as any;
  assert.equal(merged.a, 1);
  assert.equal(merged.b, 2);
  assert.equal(merged.c, 3);
});
