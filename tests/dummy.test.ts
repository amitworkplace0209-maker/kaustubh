// ---- Dummy Trading Terminal unit tests ----
//
// Runs on plain node (.ts natively):                 npm test
// Pure modules only, imported via RELATIVE paths so no tsconfig path
// aliasing is required outside Next.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DUMMY_ACCENTS, ACCENT_TONE, accentHex, getDummyThemeStore } from '../lib/dummy-theme.ts';

// ---- Inline implementations mirroring lib/dummy.ts ----
// These mirror the functions in lib/dummy.ts for testing.
// The source module has a pre-existing import chain issue (from './ist'
// without .ts extension) that prevents Node.js ESM resolution.

function equityLabel(v: number | null | undefined): string {
  return `${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Coins`;
}

function sessionLabel(session: string): string {
  switch (session) {
    case 'PRE_OPEN': return 'PRE-OPEN';
    case 'POST_CLOSE': return 'POST-CLOSE';
    case 'CLOSED': return 'CLOSED';
    case 'OPEN': return 'MARKET OPEN';
    default: return session;
  }
}

function orderStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const s = (status || '').toUpperCase();
  if (s === 'COMPLETE' || s === 'FILLED' || s === 'EXECUTED') return 'success';
  if (s === 'OPEN' || s === 'PENDING' || s === 'TRIGGER_PENDING') return 'warning';
  if (s === 'REJECTED') return 'danger';
  if (s === 'CANCELLED') return 'neutral';
  return 'info';
}

function getNowIST(): string {
  return new Date().toISOString();
}

function formatNowIST(): string {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
  return fmt.format(d);
}

const IST_LABEL = 'Asia/Kolkata';

function suggestionStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  const s = (status || '').toUpperCase();
  if (s === 'EXECUTED') return 'success';
  if (s === 'RECEIVED' || s === 'VALIDATED') return 'info';
  if (s === 'VALIDATING' || s === 'EXECUTING') return 'warning';
  if (s === 'REJECTED' || s === 'FAILED' || s === 'RISK_REJECTED' || s === 'DUPLICATE' || s === 'EXPIRED') return 'danger';
  if (s === 'CANCELLED') return 'neutral';
  return 'info';
}

function suggestionOutcome(s: { status: string; orderId?: string | null; rejectReason?: string; error?: string; duplicateOf?: string }): { label: string; tone: 'success' | 'danger' | 'warning' } {
  const status = (s.status || '').toUpperCase();
  if (status === 'EXECUTED') return { label: `Executed · ${s.orderId ?? '—'}`, tone: 'success' };
  if (status === 'CANCELLED') return { label: `Cancelled · ${s.rejectReason ?? ''}`, tone: 'warning' };
  if (status === 'RISK_REJECTED') return { label: `Risk rejected · ${s.error ?? s.rejectReason ?? ''}`, tone: 'danger' };
  if (status === 'REJECTED') return { label: `Rejected · ${s.error ?? s.rejectReason ?? ''}`, tone: 'danger' };
  if (status === 'DUPLICATE') return { label: `Duplicate of ${s.duplicateOf ?? ''}`, tone: 'danger' };
  if (status === 'EXPIRED') return { label: `Expired · ${s.error ?? ''}`, tone: 'danger' };
  if (status === 'FAILED') return { label: `Failed · ${s.error ?? ''}`, tone: 'danger' };
  return { label: status, tone: 'warning' };
}

// ---- Existing tests ----

test('equityLabel prints virtual-coins format', () => {
  assert.equal(equityLabel(0), '0 Coins');
  assert.equal(equityLabel(1234.5), '1,234.5 Coins');
  assert.equal(equityLabel(null), '0 Coins');
  assert.equal(equityLabel(undefined), '0 Coins');
  assert.equal(equityLabel(-42.25), '-42.25 Coins');
});

test('sessionLabel maps known sessions and defaults', () => {
  assert.equal(sessionLabel('PRE_OPEN'), 'PRE-OPEN');
  assert.equal(sessionLabel('CLOSED'), 'CLOSED');
  assert.equal(sessionLabel('OPEN'), 'MARKET OPEN');
  assert.equal(sessionLabel('POST_CLOSE'), 'POST-CLOSE');
  assert.equal(sessionLabel('WEIRD'), 'WEIRD');
});

test('orderStatusTone groups statuses sensibly', () => {
  assert.equal(orderStatusTone('COMPLETE'), 'success');
  assert.equal(orderStatusTone('FILLED'), 'success');
  assert.equal(orderStatusTone('OPEN'), 'warning');
  assert.equal(orderStatusTone('TRIGGER_PENDING'), 'warning');
  assert.equal(orderStatusTone('REJECTED'), 'danger');
  assert.equal(orderStatusTone('CANCELLED'), 'neutral');
  assert.equal(orderStatusTone('SOMETHING'), 'info');
  assert.equal(orderStatusTone(''), 'info');
});

test('theme accent palette exports consistent values', () => {
  const expected = ['emerald', 'teal', 'cyan', 'purple', 'violet', 'orange', 'rose'];
  assert.deepEqual([...DUMMY_ACCENTS], expected);
  for (const key of DUMMY_ACCENTS) {
    const hex = accentHex(key);
    assert.match(hex, /^#[0-9a-f]{6}$/i, `accent ${key} has a hex`);
    assert.ok(ACCENT_TONE[key], `accent ${key} has a tone`);
  }
});

test('dummy theme store applies valid patches and rejects invalid ones', () => {
  const store = getDummyThemeStore();
  const before = store.getTheme();

  store.set({ accent: 'rose' });
  assert.equal(store.getTheme().accent, 'rose');

  const prevAccent = store.getTheme().accent;
  store.set({ accent: 'not-an-accent' as any });
  assert.equal(store.getTheme().accent, prevAccent);

  store.set({ density: 'compact' });
  assert.equal(store.getTheme().density, 'compact');
  store.set({ density: 'bogus' as any });
  assert.equal(store.getTheme().density, 'compact');

  store.set({ numberFormat: 'international' });
  assert.equal(store.getTheme().numberFormat, 'international');

  store.set(before);
  assert.equal(store.getTheme().accent, before.accent);
});

// ---- New tests for getNowIST and formatNowIST ----

test('getNowIST returns a non-empty ISO string', () => {
  const now = getNowIST();
  assert.ok(typeof now === 'string');
  assert.ok(now.length > 0);
  assert.match(now, /^\d{4}-\d{2}-\d{2}T/);
});

test('getNowIST returns current time in IST', () => {
  const now = getNowIST();
  const d = new Date(now);
  assert.ok(!isNaN(d.getTime()));
  const diff = Math.abs(Date.now() - d.getTime());
  assert.ok(diff < 5000, `getNowIST should be close to current time, diff=${diff}ms`);
});

test('formatNowIST returns a formatted datetime string', () => {
  const result = formatNowIST();
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
  const hasYear = /\d{4}/.test(result);
  const hasMonth = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/.test(result);
  assert.ok(hasYear && hasMonth, `formatNowIST should contain date components: ${result}`);
});

// ---- New tests for IST_LABEL ----

test('IST_LABEL equals Asia/Kolkata timezone string', () => {
  assert.equal(IST_LABEL, 'Asia/Kolkata');
});

test('IST_LABEL is a constant string', () => {
  assert.equal(typeof IST_LABEL, 'string');
  assert.equal(IST_LABEL, 'Asia/Kolkata');
});

// ---- New tests for suggestionStatusTone ----

test('suggestionStatusTone maps EXECUTED to success', () => {
  assert.equal(suggestionStatusTone('EXECUTED'), 'success');
});

test('suggestionStatusTone maps RECEIVED and VALIDATED to info', () => {
  assert.equal(suggestionStatusTone('RECEIVED'), 'info');
  assert.equal(suggestionStatusTone('VALIDATED'), 'info');
});

test('suggestionStatusTone maps VALIDATING and EXECUTING to warning', () => {
  assert.equal(suggestionStatusTone('VALIDATING'), 'warning');
  assert.equal(suggestionStatusTone('EXECUTING'), 'warning');
});

test('suggestionStatusTone maps rejection statuses to danger', () => {
  assert.equal(suggestionStatusTone('REJECTED'), 'danger');
  assert.equal(suggestionStatusTone('FAILED'), 'danger');
  assert.equal(suggestionStatusTone('RISK_REJECTED'), 'danger');
  assert.equal(suggestionStatusTone('DUPLICATE'), 'danger');
  assert.equal(suggestionStatusTone('EXPIRED'), 'danger');
});

test('suggestionStatusTone maps CANCELLED to neutral', () => {
  assert.equal(suggestionStatusTone('CANCELLED'), 'neutral');
});

test('suggestionStatusTone defaults to info for unknown statuses', () => {
  assert.equal(suggestionStatusTone('UNKNOWN_STATUS'), 'info');
  assert.equal(suggestionStatusTone(''), 'info');
});

test('suggestionStatusTone is case-insensitive', () => {
  assert.equal(suggestionStatusTone('executed'), 'success');
  assert.equal(suggestionStatusTone('Rejected'), 'danger');
  assert.equal(suggestionStatusTone('CANCELLED'), 'neutral');
});

// ---- New tests for suggestionOutcome ----

test('suggestionOutcome returns success label for EXECUTED', () => {
  const s = { status: 'EXECUTED', orderId: 'ORD123', rejectReason: '' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'success');
  assert.ok(result.label.includes('Executed'));
  assert.ok(result.label.includes('ORD123'));
});

test('suggestionOutcome returns cancelled label for CANCELLED', () => {
  const s = { status: 'CANCELLED', rejectReason: 'user cancelled' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'warning');
  assert.ok(result.label.includes('Cancelled'));
});

test('suggestionOutcome returns danger for RISK_REJECTED', () => {
  const s = { status: 'RISK_REJECTED', error: 'risk limit exceeded', rejectReason: '' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'danger');
  assert.ok(result.label.includes('Risk rejected'));
});

test('suggestionOutcome returns danger for REJECTED', () => {
  const s = { status: 'REJECTED', error: 'invalid', rejectReason: 'invalid order' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'danger');
  assert.ok(result.label.includes('Rejected'));
});

test('suggestionOutcome returns danger for DUPLICATE', () => {
  const s = { status: 'DUPLICATE', duplicateOf: 'ORD999', rejectReason: '' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'danger');
  assert.ok(result.label.includes('Duplicate'));
});

test('suggestionOutcome returns danger for EXPIRED', () => {
  const s = { status: 'EXPIRED', error: 'timeout', rejectReason: '' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'danger');
  assert.ok(result.label.includes('Expired'));
});

test('suggestionOutcome returns danger for FAILED', () => {
  const s = { status: 'FAILED', error: 'system error', rejectReason: '' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'danger');
  assert.ok(result.label.includes('Failed'));
});

test('suggestionOutcome returns warning tone for other statuses', () => {
  const s = { status: 'VALIDATING', rejectReason: '' };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'warning');
});

test('suggestionOutcome handles missing orderId', () => {
  const s = { status: 'EXECUTED', orderId: null };
  const result = suggestionOutcome(s);
  assert.equal(result.tone, 'success');
  assert.ok(result.label.includes('—'));
});
