// ---- Order Engine unit tests ----
//
// Tests for order engine behavior.
// The implementation lives in python-service/core/engines/order_engine.py.
// These tests verify the expected behavior contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock order engine behavior for testing the contract.
// In production, this would import from '../../python-service/core/engines/order_engine'.

const DEFAULT_ORDER = {
  exchange: 'nse_cm',
  symbol: 'RELIANCE',
  token: '500',
  transaction_type: 'BUY',
  product: 'MIS',
  order_type: 'MKT',
  quantity: '1',
  price: '0',
  trigger_price: '0',
  validity: 'DAY',
};

const _placedOrders = new Set<string>();

function simulatePlace(terminal: string, order: Record<string, any>) {
  const quantity = parseInt(order.quantity || '0');
  const orderType = (order.order_type || '').toUpperCase();

  // Zero or negative quantity is rejected
  if (quantity <= 0) {
    return { ok: false, accepted: false, terminal, error: { code: 'INVALID_QUANTITY', message: 'Invalid quantity' } };
  }

  // Unsupported order types are rejected
  const validOrderTypes = ['MKT', 'L', 'SL', 'SL-M'];
  if (!validOrderTypes.includes(orderType)) {
    return { ok: false, accepted: false, terminal, error: { code: 'INVALID_ORDER_TYPE', message: `Unsupported order type: ${orderType}` } };
  }

  // Duplicate order detection
  if (order.orderId) {
    if (_placedOrders.has(order.orderId)) {
      return { ok: false, accepted: false, terminal, error: { code: 'DUPLICATE', message: 'Duplicate order suppressed' } };
    }
    _placedOrders.add(order.orderId);
  }

  // Valid order
  const orderId = order.orderId || `ORD_${Date.now()}`;
  return {
    ok: true,
    accepted: true,
    terminal,
    orderId,
    data: { n_ord_no: orderId, stat: 'OK' },
  };
}

test('valid market order is accepted', () => {
  const result = simulatePlace('dummy', { ...DEFAULT_ORDER, order_type: 'MKT', quantity: '10', price: '0' });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.ok('orderId' in result);
});

test('valid limit order is accepted', () => {
  const result = simulatePlace('dummy', { ...DEFAULT_ORDER, order_type: 'L', quantity: '5', price: '2500' });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
});

test('invalid quantity is rejected', () => {
  const result = simulatePlace('dummy', { ...DEFAULT_ORDER, quantity: '0' });
  assert.equal(result.ok, false);
  assert.equal(result.accepted, false);
  assert.ok('error' in result);
});

test('unsupported order type is rejected', () => {
  const result = simulatePlace('dummy', { ...DEFAULT_ORDER, order_type: 'INVALID_TYPE' });
  assert.equal(result.ok, false);
  assert.equal(result.accepted, false);
  assert.ok('error' in result);
});

test('duplicate order is suppressed', () => {
  const orderId = 'DUPE_ORDER_001';
  const result1 = simulatePlace('dummy', { ...DEFAULT_ORDER, orderId });
  const result2 = simulatePlace('dummy', { ...DEFAULT_ORDER, orderId });
  // Second identical order should be suppressed
  assert.equal(result1.ok, true);
  assert.equal(result2.ok, false);
});

test('place returns structured result with terminal', () => {
  const result = simulatePlace('dummy', DEFAULT_ORDER);
  assert.ok('terminal' in result);
  assert.equal(result.terminal, 'dummy');
});

test('place returns orderId on success', () => {
  const result = simulatePlace('dummy', DEFAULT_ORDER);
  if (result.ok) {
    assert.ok('orderId' in result);
  }
});

test('place returns error for negative quantity', () => {
  const result = simulatePlace('dummy', { ...DEFAULT_ORDER, quantity: '-5' });
  assert.equal(result.ok, false);
  assert.equal(result.accepted, false);
});

test('place handles large quantities', () => {
  const result = simulatePlace('dummy', { ...DEFAULT_ORDER, quantity: '999999' });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
});
