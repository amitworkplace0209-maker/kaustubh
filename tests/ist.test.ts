// ---- IST utility functions unit tests ----
//
// Runs on plain node (npm test): imports the pure helpers via relative path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toIST,
  formatIST,
  formatISTTime,
  formatISTDate,
  formatISTDateTime,
  getISTNow,
  getISTTimestamp,
  formatDuration,
  IST_TIMEZONE,
} from '../lib/ist.ts';

test('toIST converts a Date to IST representation', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const ist = toIST(d);
  assert.ok(ist instanceof Date);
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(ist).map(p => [p.type, p.value]));
  assert.equal(parts.year, '2024');
});

test('toIST handles string input', () => {
  const ist = toIST('2024-12-01T10:00:00Z');
  assert.ok(ist instanceof Date);
});

test('toIST does not mutate the input Date', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const before = d.getTime();
  toIST(d);
  assert.equal(d.getTime(), before);
});

test('formatIST returns a localized IST string', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const result = formatIST(d);
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
});

test('formatISTTime returns time in Asia/Kolkata', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const result = formatISTTime(d);
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
  // The result should be a time string like "10:00 AM"
  assert.match(result, /\d{1,2}:\d{2}/);
  // Verify it's in 12-hour format with AM/PM
  assert.ok(result.includes('AM') || result.includes('PM') || result.includes('am') || result.includes('pm'));
});

test('formatISTDate returns a date string with month name', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const result = formatISTDate(d);
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
  // Should contain a month abbreviation
  assert.ok(
    result.includes('Dec') || result.includes('Jan') || result.includes('Feb'),
    `formatISTDate should contain month name, got: ${result}`,
  );
});

test('formatISTDateTime returns a full datetime string', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const result = formatISTDateTime(d);
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
  // Should contain both date and time components
  assert.ok(result.includes('2024') || result.includes('Dec'));
});

test('getISTNow returns a Date object', () => {
  const ist = getISTNow();
  assert.ok(ist instanceof Date);
  assert.ok(!isNaN(ist.getTime()));
});

test('getISTNow returns time in Asia/Kolkata timezone', () => {
  const ist = getISTNow();
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(ist).map(p => [p.type, p.value]));
  assert.match(parts.hour, /^\d{2}$/);
});

test('getISTTimestamp returns an ISO string', () => {
  const ts = getISTTimestamp();
  assert.ok(typeof ts === 'string');
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('formatDuration returns human-readable strings', () => {
  assert.equal(formatDuration(5000), '5 sec ago');
  assert.equal(formatDuration(60000), '1 min ago');
  assert.equal(formatDuration(120000), '2 min ago');
  assert.equal(formatDuration(3600000), '1h ago');
  assert.equal(formatDuration(3660000), '1h 1m ago');
  assert.equal(formatDuration(7260000), '2h 1m ago');
  assert.equal(formatDuration(0), '0 sec ago');
});

test('formatDuration handles negative values', () => {
  assert.equal(formatDuration(-5000), '5 sec ago');
  assert.equal(formatDuration(-60000), '1 min ago');
});

test('formatDuration always returns a string ending with "ago"', () => {
  for (const ms of [1000, 30000, 90000, 3600000, 7200000]) {
    const result = formatDuration(ms);
    assert.ok(result.endsWith('ago'), `Expected "${result}" to end with "ago"`);
  }
});

test('formatIST accepts Date and string options', () => {
  const d = new Date('2024-12-01T10:00:00Z');
  const result1 = formatIST(d, { hour: 'numeric' });
  const result2 = formatIST('2024-12-01T10:00:00Z', { hour: 'numeric' });
  assert.equal(result1, result2);
});
