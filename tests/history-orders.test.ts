// ---- Order History normalizer + bucket unit tests ----
//
// Covers the History page's pure logic (components/orders/history/types.ts):
// tolerant normalization of embedded-demo and Kotak broker order rows,
// canonical bucket derivation, mutation gating and IST date grouping.
// No fabricated values may ever leak from unknown payload fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalOrderStatus } from '../components/orders/trade/lifecycle.ts';
import {
  canCancel,
  canModify,
  historyRowBucket,
  istDateOf,
  normalizeOrderRow,
  orderTimeMs,
} from '../components/orders/history/types.ts';

test('normalizeOrderRow maps the embedded demo shape', () => {
  const row = normalizeOrderRow({
    orderId: 'ORD1',
    symbol: 'RELIANCE',
    tradingSymbol: 'RELIANCE-EQ',
    transactionType: 'BUY',
    product: 'MIS',
    orderType: 'MKT',
    quantity: 2,
    price: 2500,
    triggerPrice: 0,
    status: 'COMPLETE',
    averageTradedPrice: 2500.5,
    filledQuantity: 2,
    unfilledQuantity: 0,
    orderDate: '2026-09-20T06:30:00.000Z',
    errorMessage: null,
    source: 'MANUAL',
  });
  assert.equal(row.orderId, 'ORD1');
  assert.equal(row.symbol, 'RELIANCE');
  assert.equal(row.transactionType, 'BUY');
  assert.equal(row.product, 'MIS');
  assert.equal(row.orderType, 'MKT');
  assert.equal(row.quantity, 2);
  assert.equal(row.price, 2500);
  assert.equal(row.averageTradedPrice, 2500.5);
  assert.equal(row.filledQuantity, 2);
  assert.equal(row.unfilledQuantity, 0);
  assert.ok(row.orderDate);
  assert.equal(canonicalOrderStatus(row.rawStatus), 'FILLED');
  assert.equal(historyRowBucket(canonicalOrderStatus(row.rawStatus)), 'FILLED');
});

test('normalizeOrderRow maps the Kotak order-book shape', () => {
  const row = normalizeOrderRow({
    orderid: 'kotak-42',
    scripname: 'HDFCBANK',
    st: 'Rejected',
    prd: 'MIS',
    ordType: 'L',
    ordqty: 10,
    ordprc: 1600,
    avg: 1600.25,
    exchtm: '2026-09-20T05:00:00+05:30',
    errormsg: 'insufficient margin',
  });
  assert.equal(row.orderId, 'kotak-42');
  assert.equal(row.symbol, 'HDFCBANK');
  assert.equal(row.product, 'MIS');
  assert.equal(row.orderType, 'L');
  assert.equal(row.quantity, 10);
  assert.equal(row.price, 1600);
  assert.equal(canonicalOrderStatus(row.rawStatus), 'REJECTED');
  assert.equal(historyRowBucket(canonicalOrderStatus(row.rawStatus)), 'REJECTED');
  assert.match(row.errorMessage ?? '', /margin/i);
});

test('normalizeOrderRow keeps unknown fields null, never fabricated', () => {
  const row = normalizeOrderRow({ orderId: 'ORD2', status: 'STRANGE_STATE' });
  assert.equal(row.price, null);
  assert.equal(row.averageTradedPrice, null);
  assert.equal(row.filledQuantity, null);
  assert.equal(canonicalOrderStatus(row.rawStatus), 'STRANGE_STATE');
  assert.equal(historyRowBucket('STRANGE_STATE'), 'OPEN');
});

test('orderTimeMs accepts ISO, epoch numbers, and handles garbage', () => {
  const iso = orderTimeMs({ orderDate: '2026-09-20T06:30:00.000Z' });
  assert.ok(iso && iso > 0);
  const epoch = orderTimeMs({ orderDate: 1726800000000 });
  assert.equal(epoch, 1726800000000);
  const junk = orderTimeMs({ orderDate: 'not-a-date' });
  assert.equal(junk, null);
  const missing = orderTimeMs({});
  assert.equal(missing, null);
});

test('istDateOf renders a stable Asia/Kolkata grouping key', () => {
  const d = new Date('2026-09-20T06:30:00.000Z').getTime(); // 12:00 noon IST
  assert.equal(istDateOf(d), '20/09/2026');
  assert.equal(istDateOf(null), 'unknown');
  assert.equal(istDateOf(Number.NaN), 'unknown');
});

test('historyRowBucket maps every canonical status to the right bucket', () => {
  assert.equal(historyRowBucket('FILLED'), 'FILLED');
  assert.equal(historyRowBucket('PARTIALLY_FILLED'), 'PARTIALLY_FILLED');
  assert.equal(historyRowBucket('CANCELLED'), 'CANCELLED');
  assert.equal(historyRowBucket('REJECTED'), 'REJECTED');
  assert.equal(historyRowBucket('OPEN'), 'OPEN');
  assert.equal(historyRowBucket('UNKNOWN'), 'OPEN');
});

test('canCancel / canModify gate only actionable pending states', () => {
  assert.equal(canCancel('OPEN'), true);
  assert.equal(canCancel('PARTIALLY_FILLED'), true);
  assert.equal(canCancel('FILLED'), false);
  assert.equal(canCancel('CANCELLED'), false);
  assert.equal(canCancel('REJECTED'), false);
  assert.equal(canModify('OPEN'), true);
  assert.equal(canModify('PARTIALLY_FILLED'), true);
  assert.equal(canModify('FILLED'), false);
  assert.equal(canModify('CANCELLED'), false);
});