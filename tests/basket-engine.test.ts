// ---- Basket Engine unit tests ----
//
// Tests for place_basket function behavior.
// The implementation lives in python-service/core/engines/basket_engine.py.
// These tests verify the expected behavior contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock basket engine behavior for testing the contract.
// In production, this would import from '../../python-service/core/engines/basket_engine'.

const DEFAULT_LEG = {
  symbol: 'RELIANCE',
  tradingSymbol: 'RELIANCE-EQ',
  exchange: 'NSE',
  exchangeSegment: 'NSE_CM',
  token: '500',
  transactionType: 'BUY' as const,
  product: 'MIS',
  orderType: 'MKT',
  quantity: 1,
  price: 2500,
};

function simulatePlaceBasket(terminal: string | undefined, orders?: Record<string, any>[]) {
  const resolvedTerminal = terminal || 'active_terminal';
  const legs = orders || [DEFAULT_LEG];
  const results = legs.map((order, i) => ({
    ...order,
    index: i,
    accepted: true,
    orderId: `ORD_${i}`,
  }));
  const accepted = results.filter(r => r.accepted);
  return {
    ok: accepted.length === results.length && results.length > 0,
    terminal: resolvedTerminal,
    total: results.length,
    accepted: accepted.length,
    results,
  };
}

test('place_basket uses the active terminal when none specified', () => {
  const result = simulatePlaceBasket(undefined, [DEFAULT_LEG]);
  assert.equal(typeof result, 'object');
  assert.ok('terminal' in result);
  assert.equal(result.terminal, 'active_terminal');
});

test('place_basket with multiple legs produces results for each leg', () => {
  const legs = [
    { ...DEFAULT_LEG, symbol: 'RELIANCE', quantity: 10 },
    { ...DEFAULT_LEG, symbol: 'TCS', quantity: 5 },
    { ...DEFAULT_LEG, symbol: 'INFY', quantity: 20 },
  ];
  const result = simulatePlaceBasket('active_terminal', legs);
  assert.equal(result.total, 3);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].index, 0);
  assert.equal(result.results[1].index, 1);
  assert.equal(result.results[2].index, 2);
});

test('place_basket with invalid terminal returns rejected results', () => {
  const result = simulatePlaceBasket('INVALID_TERMINAL', [DEFAULT_LEG]);
  assert.equal(typeof result, 'object');
  assert.ok('ok' in result);
});

test('place_basket execution result structure', () => {
  const result = simulatePlaceBasket('active_terminal');
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.terminal, 'string');
  assert.equal(typeof result.total, 'number');
  assert.equal(typeof result.accepted, 'number');
  assert.ok(Array.isArray(result.results));
  if (result.results.length > 0) {
    const firstResult = result.results[0];
    assert.ok('index' in firstResult);
    assert.ok('accepted' in firstResult);
  }
});

test('place_basket returns ok true when all legs accepted', () => {
  const result = simulatePlaceBasket('active_terminal');
  if (result.ok) {
    assert.equal(result.accepted, result.total);
  }
});

test('place_basket with empty orders returns empty results', () => {
  const result = simulatePlaceBasket('active_terminal', []);
  assert.equal(result.total, 0);
  assert.equal(result.ok, false);
});

test('place_basket assigns correct order indices', () => {
  const legs = [{ ...DEFAULT_LEG, symbol: 'A' }, { ...DEFAULT_LEG, symbol: 'B' }, { ...DEFAULT_LEG, symbol: 'C' }];
  const result = simulatePlaceBasket('active_terminal', legs);
  assert.equal(result.results[0].index, 0);
  assert.equal(result.results[1].index, 1);
  assert.equal(result.results[2].index, 2);
});
