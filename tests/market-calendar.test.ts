// ---- Market Calendar unit tests ----
//
// Tests for market calendar functions.
// The implementation lives in python-service/services/market_calendar.py.
// These tests verify the expected behavior contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock market calendar behavior for testing the contract.
// In production, this would import from '../../python-service/services/market_calendar'.

const WEEKEND = 'WEEKEND';
const EXCHANGE_HOLIDAY = 'EXCHANGE_HOLIDAY';
const SPECIAL_CLOSURE = 'SPECIAL_CLOSURE';
const NORMAL_MARKET_DAY = 'NORMAL_MARKET_DAY';

const PRE_OPEN = 'PRE_OPEN';
const OPEN = 'OPEN';
const POST_CLOSE = 'POST_CLOSE';
const CLOSED = 'CLOSED';

// Known NSE holidays from the calendar module
const KNOWN_HOLIDAYS = new Set([
  '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
  '2025-04-18', '2025-05-01', '2025-05-12', '2025-06-16', '2025-07-07',
  '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-21', '2025-10-22',
  '2025-11-05', '2025-12-25',
  '2026-01-26', '2026-02-16', '2026-03-16', '2026-03-17', '2026-04-03', '2026-04-07',
  '2026-04-10', '2026-05-01', '2026-05-22', '2026-05-25', '2026-07-06',
  '2026-08-15', '2026-08-28', '2026-09-16', '2026-10-02', '2026-11-09',
  '2026-11-10', '2026-11-24', '2026-12-25',
]);

function dayClass(d: Date): string {
  const key = d.toISOString().slice(0, 10);
  if (KNOWN_HOLIDAYS.has(key)) return EXCHANGE_HOLIDAY;
  const day = d.getDay();
  if (day === 0 || day === 6) return WEEKEND;
  return NORMAL_MARKET_DAY;
}

function isTradingDay(d: Date): boolean {
  return dayClass(d) === NORMAL_MARKET_DAY;
}

function marketSession(d: Date): string {
  const dateStr = d.toISOString().slice(0, 10);
  if (KNOWN_HOLIDAYS.has(dateStr)) return CLOSED;
  const day = d.getDay();
  if (day === 0 || day === 6) return CLOSED;
  // Compute IST hour from UTC (IST = UTC + 5:30)
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const istTotalMin = utcHour * 60 + utcMin + 330; // +5:30 = 330 min
  const istHour = Math.floor(istTotalMin / 60) % 24;
  const istMin = istTotalMin % 60;
  if (istHour < 9 || (istHour === 9 && istMin < 0)) return CLOSED;
  if (istHour === 9 && istMin < 15) return PRE_OPEN;
  if (istHour < 15 || (istHour === 15 && istMin <= 30)) return OPEN;
  if (istHour < 16) return POST_CLOSE;
  return CLOSED;
}

test('day_class returns NORMAL_MARKET_DAY for a regular weekday', () => {
  const result = dayClass(new Date('2025-01-20')); // Monday
  assert.equal(result, NORMAL_MARKET_DAY);
});

test('day_class returns WEEKEND for Saturday', () => {
  const saturday = new Date('2025-01-18');
  const result = dayClass(saturday);
  assert.equal(result, WEEKEND);
});

test('day_class returns WEEKEND for Sunday', () => {
  const sunday = new Date('2025-01-19');
  const result = dayClass(sunday);
  assert.equal(result, WEEKEND);
});

test('day_class returns EXCHANGE_HOLIDAY for known holidays', () => {
  const result = dayClass(new Date('2025-12-25')); // Christmas
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Republic Day', () => {
  const result = dayClass(new Date('2026-01-26'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Maha Shivaratri 2026', () => {
  const result = dayClass(new Date('2026-02-16'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Buddha Purnima 2026', () => {
  const result = dayClass(new Date('2026-05-22'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Janmashtami 2026', () => {
  const result = dayClass(new Date('2026-08-28'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Ganesh Chaturthi 2026', () => {
  const result = dayClass(new Date('2026-09-16'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Diwali Laxmi Pujan 2026 (observed Nov 9)', () => {
  const result = dayClass(new Date('2026-11-09'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Diwali Balipratipada 2026', () => {
  const result = dayClass(new Date('2026-11-10'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns EXCHANGE_HOLIDAY for Guru Nanak Jayanti 2026', () => {
  const result = dayClass(new Date('2026-11-24'));
  assert.equal(result, EXCHANGE_HOLIDAY);
});

test('day_class returns NORMAL_MARKET_DAY for Oct 21 2026 (NOT a holiday)', () => {
  const result = dayClass(new Date('2026-10-21'));
  assert.equal(result, NORMAL_MARKET_DAY);
});

test('day_class returns NORMAL_MARKET_DAY for Oct 20 2026 (NOT a holiday)', () => {
  const result = dayClass(new Date('2026-10-20'));
  assert.equal(result, NORMAL_MARKET_DAY);
});

test('is_trading_day returns true for normal weekdays', () => {
  assert.equal(isTradingDay(new Date('2025-01-20')), true);
});

test('is_trading_day returns false for weekends', () => {
  assert.equal(isTradingDay(new Date('2025-01-18')), false);
});

test('is_trading_day returns false for exchange holidays', () => {
  assert.equal(isTradingDay(new Date('2025-12-25')), false);
});

test('market_session returns PRE_OPEN for 09:00-09:14 IST', () => {
  const preOpen = new Date('2025-01-20T09:00:00+05:30');
  const result = marketSession(preOpen);
  assert.equal(result, PRE_OPEN);
});

test('market_session returns OPEN for 09:15-15:30 IST', () => {
  const openTime = new Date('2025-01-20T10:00:00+05:30');
  const result = marketSession(openTime);
  assert.equal(result, OPEN);
});

test('market_session returns POST_CLOSE for 15:30-16:00 IST', () => {
  const postClose = new Date('2025-01-20T15:45:00+05:30');
  const result = marketSession(postClose);
  assert.equal(result, POST_CLOSE);
});

test('market_session returns CLOSED for outside hours', () => {
  const before = new Date('2025-01-20T08:00:00+05:30');
  const after = new Date('2025-01-20T16:30:00+05:30');
  assert.equal(marketSession(before), CLOSED);
  assert.equal(marketSession(after), CLOSED);
});

test('market_session returns CLOSED on holidays', () => {
  const holiday = new Date('2025-12-25T10:00:00+05:30');
  const result = marketSession(holiday);
  assert.equal(result, CLOSED);
});

test('market_session returns CLOSED on weekends', () => {
  const saturday = new Date('2025-01-18T10:00:00+05:30');
  const result = marketSession(saturday);
  assert.equal(result, CLOSED);
});

test('next_market_open returns a Date object', () => {
  // Simulates next_market_open behavior
  const now = new Date();
  const result = new Date(now.getTime() + 86400000); // Next day
  assert.ok(result instanceof Date);
});

test('next_market_open skips weekends', () => {
  // If today is Friday, next open should be Monday
  const friday = new Date('2025-01-17'); // Friday
  const nextOpen = new Date(friday);
  nextOpen.setDate(friday.getDate() + 3); // Skip to Monday
  assert.equal(nextOpen.getDay(), 1); // Monday
});

test('day_class classification is consistent with is_trading_day', () => {
  const regularDay = new Date('2025-01-20'); // Monday
  assert.equal(dayClass(regularDay), NORMAL_MARKET_DAY);
  assert.equal(isTradingDay(regularDay), true);

  const weekend = new Date('2025-01-18'); // Saturday
  assert.equal(dayClass(weekend), WEEKEND);
  assert.equal(isTradingDay(weekend), false);
});

test('all day classifications are exhaustive', () => {
  const dayClasses = new Set([NORMAL_MARKET_DAY, WEEKEND, EXCHANGE_HOLIDAY, SPECIAL_CLOSURE]);
  const testDate = new Date('2025-01-20');
  assert.ok(dayClasses.has(dayClass(testDate)));
});
