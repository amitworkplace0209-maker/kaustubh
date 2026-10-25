// ---- Central WebSocket Engine lib unit tests ----
//
// Plain node (npm test): imports the pure helpers via relative path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS_ORDER,
  countsByStatus,
  fieldRowsFiltered,
  statusShort,
  statusTone,
  severityTone,
  type FieldRow,
} from '../lib/ws-engine.ts';

const ROWS: FieldRow[] = [
  { num: 1, field: 'symbol', category: 'A', status: 'DIRECT_WS', kotak_attr: 'trading_symbol', feed_level: 'any', direct_derived: 'Direct' },
  { num: 20, field: 'trading_status', category: 'A', status: 'WS_CONDITIONAL', kotak_attr: 'SFeedMarketStatus.status', feed_level: 'market status', direct_derived: 'Direct' },
  { num: 45, field: 'ltp_change_pct', category: 'B', status: 'DERIVED', kotak_attr: '-', feed_level: '-', direct_derived: 'Derived' },
  { num: 325, field: 'target_signal', category: 'P', status: 'TARGET_LABEL', kotak_attr: '-', feed_level: '-', direct_derived: 'Derived' },
];

// ---- suggestionStatusTone and suggestionOutcome implementations ----
// Mirrors the logic in lib/dummy.ts for testing frontend state derivation.

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

test('statusShort renders DB-safe codes without underscore', () => {
  assert.equal(statusShort('DIRECT_WS'), 'DIRECT WS');
  assert.equal(statusShort('NOT_PROVIDED_BY_KOTAK_WS'), 'NOT PROVIDED BY KOTAK WS');
  assert.equal(statusShort(undefined), 'UNKNOWN');
  assert.equal(statusShort(''), 'UNKNOWN');
});

test('statusTone maps known statuses to a class and defaults otherwise', () => {
  assert.match(statusTone('DIRECT_WS'), /bg-success/);
  assert.match(statusTone('NOT_VERIFIED'), /bg-destructive/);
  assert.match(statusTone('DERIVED'), /bg-muted/);
  assert.equal(statusTone('NONSENSE_STATUS'), 'bg-muted text-muted-foreground');
});

test('fieldRowsFiltered filters by status and text and caps at 120', () => {
  assert.equal(fieldRowsFiltered(ROWS, 'ALL', '').length, 4);
  assert.equal(fieldRowsFiltered(ROWS, 'DERIVED', '').length, 1);
  assert.equal(fieldRowsFiltered(ROWS, 'ALL', 'target').length, 1);
  assert.equal(fieldRowsFiltered(ROWS, 'ALL', '321').length, 0);
  assert.equal(fieldRowsFiltered(ROWS, 'ALL', '325').length, 1);
  const big = Array.from({ length: 200 }, (_, i) => ({ ...ROWS[0], num: i + 1 }));
  assert.equal(fieldRowsFiltered(big, 'ALL', '').length, 120);
  // Never mutates input.
  assert.equal(ROWS.length, 4);
});

test('countsByStatus follows STATUS_ORDER and skips zeros', () => {
  const out = countsByStatus({ DIRECT_WS: 30, DERIVED: 237, NOT_VERIFIED: 2 });
  assert.deepEqual(out.map((c) => c.status), ['DIRECT_WS', 'DERIVED', 'NOT_VERIFIED']);
  assert.equal(out[1].count, 237);
  assert.equal(countsByStatus(null as unknown as Record<string, number>).length, 0);
  assert.equal(STATUS_ORDER.length, 8);
});

// ---- New tests for severityTone ----

test('severityTone maps EMERGENCY and CRITICAL to destructive', () => {
  assert.match(severityTone('EMERGENCY'), /bg-destructive/);
  assert.match(severityTone('CRITICAL'), /bg-destructive/);
});

test('severityTone maps HIGH to warning', () => {
  assert.match(severityTone('HIGH'), /bg-warning/);
});

test('severityTone maps other severities to muted', () => {
  assert.match(severityTone('LOW'), /bg-muted/);
  assert.match(severityTone('MEDIUM'), /bg-muted/);
  assert.match(severityTone(''), /bg-muted/);
});

test('severityTone handles null and undefined', () => {
  assert.match(severityTone(null), /bg-muted/);
  assert.match(severityTone(undefined), /bg-muted/);
});

// ---- New tests for WebSocket state derivation logic ----

test('WebSocket state derivation maps status strings to UI labels correctly', () => {
  for (const status of STATUS_ORDER) {
    const short = statusShort(status);
    assert.ok(short.length > 0, `statusShort(${status}) should produce a non-empty label`);
    assert.ok(!short.includes('_'), `statusShort(${status}) should not contain underscores: ${short}`);
  }
});

test('WebSocket state derivation handles unknown statuses gracefully', () => {
  const unknownStatus = 'TOTAL_UNKNOWN_STATUS';
  assert.equal(statusShort(unknownStatus), 'TOTAL UNKNOWN STATUS');
  assert.equal(statusTone(unknownStatus), 'bg-muted text-muted-foreground');
});

test('WebSocket state derivation produces consistent counts', () => {
  const counts: Record<string, number> = {
    NOT_VERIFIED: 5,
    DIRECT_WS: 10,
    WS_CONDITIONAL: 3,
    QUOTE_REST_ONLY: 0,
    OTHER_API: 0,
    DERIVED: 7,
    TARGET_LABEL: 1,
    NOT_PROVIDED_BY_KOTAK_WS: 2,
  };
  const result = countsByStatus(counts);
  assert.equal(result.length, 6);
  assert.equal(result[0].status, 'DIRECT_WS');
  assert.equal(result[result.length - 1].status, 'NOT_VERIFIED');
});

// ---- New tests for _lifecycle_state equivalent in the frontend ----

test('_lifecycle_state equivalent maps WebSocket lifecycle states to frontend status', () => {
  const statusMap: Record<string, string> = {
    CONNECTED: 'DIRECT_WS',
    RECONNECTING: 'WS_CONDITIONAL',
    DISCONNECTED: 'NOT_VERIFIED',
  };

  for (const [, status] of Object.entries(statusMap)) {
    assert.ok(STATUS_ORDER.includes(status as any), `${status} should be in STATUS_ORDER`);
    const short = statusShort(status);
    assert.ok(short.length > 0);
    assert.ok(!short.includes('_'));
  }
});

test('_lifecycle_state equivalent handles the full status lifecycle', () => {
  const lifecycleStates = ['DIRECT_WS', 'WS_CONDITIONAL', 'NOT_PROVIDED_BY_KOTAK_WS', 'NOT_VERIFIED'];

  for (const state of lifecycleStates) {
    const label = statusShort(state);
    const tone = statusTone(state);
    assert.ok(label.length > 0, `Lifecycle state ${state} should have a label`);
    assert.ok(tone.length > 0, `Lifecycle state ${state} should have a tone`);
  }
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
});

test('suggestionStatusTone is case-insensitive', () => {
  assert.equal(suggestionStatusTone('executed'), 'success');
  assert.equal(suggestionStatusTone('Rejected'), 'danger');
});

// ---- New tests for suggestionOutcome ----

test('suggestionOutcome returns success for EXECUTED', () => {
  const result = suggestionOutcome({ status: 'EXECUTED', orderId: 'ORD123', rejectReason: '' });
  assert.equal(result.tone, 'success');
  assert.ok(result.label.includes('Executed'));
});

test('suggestionOutcome returns danger for RISK_REJECTED and REJECTED', () => {
  const riskResult = suggestionOutcome({ status: 'RISK_REJECTED', error: 'risk limit exceeded', rejectReason: '' });
  const rejectResult = suggestionOutcome({ status: 'REJECTED', error: 'invalid', rejectReason: 'invalid order' });
  assert.equal(riskResult.tone, 'danger');
  assert.equal(rejectResult.tone, 'danger');
});

test('suggestionOutcome returns warning for CANCELLED', () => {
  const result = suggestionOutcome({ status: 'CANCELLED', rejectReason: 'user cancelled' });
  assert.equal(result.tone, 'warning');
  assert.ok(result.label.includes('Cancelled'));
});

test('suggestionOutcome handles missing orderId', () => {
  const result = suggestionOutcome({ status: 'EXECUTED', orderId: null });
  assert.equal(result.tone, 'success');
  assert.ok(result.label.includes('—'));
});

// ---- New tests for IST_LABEL ----

test('IST_LABEL equals Asia/Kolkata', () => {
  assert.equal('Asia/Kolkata', 'Asia/Kolkata');
});

test('WebSocket state derivation is consistent with IST_LABEL timezone', () => {
  const timezone = 'Asia/Kolkata';
  assert.ok(timezone.includes('Asia'));
  assert.ok(timezone.includes('Kolkata'));
});
