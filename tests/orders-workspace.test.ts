// ---- Orders workspace unit tests ----
//
// Pure helpers in lib/order-workspace.ts: keyboard nav, order math and ticket
// validation. Broker numbers (LTP/margin/charges) always come from the backend
// — these tests only pin the client math.
//
// The search constants moved to lib/instrument-search.ts (the canonical Search
// Engine contract) so all search call sites share one definition; the gating
// cases are re-pinned here from their new home.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEARCH_MIN_CHARS,
  SEARCH_SUGGESTION_LIMIT,
  shouldSearch,
} from '../lib/instrument-search.ts';
import {
  ORDER_ROUTES,
  chargesTotal,
  hasMarginShortfall,
  marginAfterOrder,
  marginPerShare,
  marginFactor,
  nextSuggestionIndex,
  orderValue,
  quantityFromMargin,
  validateTicket,
} from '../lib/order-workspace.ts';

// ---- search gating ----

test('search starts only after the minimum characters', () => {
  assert.equal(shouldSearch(''), false);
  assert.equal(shouldSearch('R'), false);
  assert.equal(shouldSearch('  '), false);
  assert.equal(shouldSearch('RE'), true);
  assert.equal(shouldSearch('REL'), true);
  assert.equal(SEARCH_MIN_CHARS, 2);
});

test('suggestion list stays small', () => {
  assert.ok(SEARCH_SUGGESTION_LIMIT >= 5 && SEARCH_SUGGESTION_LIMIT <= 10);
});

// ---- keyboard navigation ----

test('arrow keys move and wrap the highlight', () => {
  assert.equal(nextSuggestionIndex(-1, 5, 'down'), 0);
  assert.equal(nextSuggestionIndex(0, 5, 'down'), 1);
  assert.equal(nextSuggestionIndex(4, 5, 'down'), 0);
  assert.equal(nextSuggestionIndex(0, 5, 'up'), 4);
  assert.equal(nextSuggestionIndex(2, 5, 'up'), 1);
  assert.equal(nextSuggestionIndex(-1, 0, 'down'), -1);
});

// ---- order math ----

test('order value is quantity x price', () => {
  assert.equal(orderValue(10, 2450), 24500);
  assert.equal(orderValue(0, 2450), null);
  assert.equal(orderValue(10, null), null);
  assert.equal(orderValue(10, 0), null);
  assert.equal(orderValue(1.5, 100), null);
});

test('margin after order and shortfall', () => {
  assert.equal(marginAfterOrder(100000, 12400), 87600);
  assert.equal(marginAfterOrder(null, 12400), null);
  assert.equal(marginAfterOrder(100000, null), null);
  assert.equal(hasMarginShortfall(100000, 120000), true);
  assert.equal(hasMarginShortfall(100000, 100000), false);
  assert.equal(hasMarginShortfall(null, 120000), false);
});

// ---- charges ----

test('charges total prefers the backend total, else sums rows', () => {
  assert.equal(
    chargesTotal({ brokerage: 20, stt: 10, total: 40, exchangeTransactionCharges: 5, gst: 3, sebiCharges: 1, stampDuty: 1 }),
    40,
  );
  assert.equal(
    chargesTotal({ brokerage: 20, stt: 10, exchangeTransactionCharges: 5, gst: 3, sebiCharges: 1, stampDuty: 1 }),
    40,
  );
  assert.equal(chargesTotal(null), null);
  assert.equal(chargesTotal({}), null);
});

// ---- validation ----

test('ticket validation blocks impossible orders', () => {
  assert.equal(validateTicket({ hasSelection: false, quantity: '10', needsPrice: false, price: '0', needsTrigger: false, triggerPrice: '0' }).valid, false);
  const badQty = validateTicket({ hasSelection: true, quantity: '0', needsPrice: false, price: '0', needsTrigger: false, triggerPrice: '0' });
  assert.equal(badQty.valid, false);
  assert.ok(badQty.errors.some((e) => e.includes('Quantity')));
  const badPrice = validateTicket({ hasSelection: true, quantity: '10', needsPrice: true, price: '0', needsTrigger: false, triggerPrice: '0' });
  assert.equal(badPrice.valid, false);
  const badTrigger = validateTicket({ hasSelection: true, quantity: '10', needsPrice: false, price: '0', needsTrigger: true, triggerPrice: '' });
  assert.equal(badTrigger.valid, false);
  const good = validateTicket({ hasSelection: true, quantity: '10', needsPrice: true, price: '2450', needsTrigger: false, triggerPrice: '0' });
  assert.equal(good.valid, true);
});

// ---- navigation: sidebar owns the routes, no in-page duplicates ----

test('the three Trading children are distinct real routes', () => {
  const children = [ORDER_ROUTES.trade, ORDER_ROUTES.suggestion, ORDER_ROUTES.history];
  assert.equal(new Set(children).size, children.length);
  assert.equal(ORDER_ROUTES.trade, '/trading/trade');
  assert.equal(ORDER_ROUTES.suggestion, '/trading/suggestion');
  assert.equal(ORDER_ROUTES.history, '/trading/history');
});

test('the legacy orders entry aliases Trade instead of duplicating it', () => {
  // Orders is no longer a standalone page: the sidebar group is Trading and its
  // first child is Trade, so `orders` and `trade` MUST resolve to one route or
  // the sidebar grows a duplicate item.
  assert.equal(ORDER_ROUTES.orders, ORDER_ROUTES.trade);
});

// ---- margin-driven sizing -------------------------------------------------
//
// The reported bug: entering a margin amount produced a quantity derived from
// the LTP (400 / 200 = 2 shares) instead of from the margin per share
// (400 / 40 = 10 shares), so the order value never matched the amount.

test('margin factor mirrors the dummy engine product rules', () => {
  assert.equal(marginFactor('MIS'), 0.2);
  assert.equal(marginFactor('INTRADAY'), 0.2);
  assert.equal(marginFactor('CNC'), 1);
  assert.equal(marginFactor('NRML'), 1);
  assert.equal(marginFactor('nonsense'), 1);
});

test('margin per share prefers the broker number, else the product factor', () => {
  // The reported case: LTP 200, MIS => ₹40 of margin per share.
  assert.equal(marginPerShare({ price: 200, product: 'MIS' }), 40);
  // A broker-reported 1-qty margin always wins over the heuristic.
  assert.equal(marginPerShare({ price: 200, product: 'MIS', oneQtyMargin: 37.5 }), 37.5);
  // Delivery products block full value.
  assert.equal(marginPerShare({ price: 200, product: 'CNC' }), 200);
  // No price and no broker number => unknown, never zero (0 would size a huge order).
  assert.equal(marginPerShare({ price: null, product: 'MIS' }), null);
  assert.equal(marginPerShare({ price: 0, product: 'MIS' }), null);
});

test('quantity is derived from the margin, not the price', () => {
  // 400 of margin at 40/share => 10 shares. Dividing by the LTP (2) was the bug.
  assert.equal(quantityFromMargin({ marginAmount: 400, perShare: 40 }), 10);
  assert.equal(quantityFromMargin({ marginAmount: 4000, perShare: 40 }), 100);
  // Fractional shares always round DOWN to a whole share.
  assert.equal(quantityFromMargin({ marginAmount: 400, perShare: 30 }), 13);
  assert.equal(quantityFromMargin({ marginAmount: 399, perShare: 40 }), 9);
});

test('quantity is lot-aligned and refuses an unfundable lot', () => {
  assert.equal(quantityFromMargin({ marginAmount: 4000, perShare: 40, lotSize: 50 }), 100);
  // 12 affordable shares but the instrument trades in lots of 10 => 10, never 12.
  assert.equal(quantityFromMargin({ marginAmount: 480, perShare: 40, lotSize: 10 }), 10);
  // Cannot fund a single lot => null, so the caller can say so instead of
  // silently placing 1 lot it has no margin for.
  assert.equal(quantityFromMargin({ marginAmount: 300, perShare: 40, lotSize: 10 }), null);
  assert.equal(quantityFromMargin({ marginAmount: 0, perShare: 40 }), null);
  assert.equal(quantityFromMargin({ marginAmount: 400, perShare: null }), null);
});

test('the margin block never exceeds the committed amount', () => {
  for (const amount of [400, 4000, 12345, 999]) {
    for (const price of [37.5, 200, 1189.99]) {
      const per = marginPerShare({ price, product: 'MIS' });
      assert.ok(per != null);
      const qty = quantityFromMargin({ marginAmount: amount, perShare: per });
      assert.ok(qty != null && qty >= 1);
      assert.ok(per * qty <= amount, `${per * qty} must not exceed ${amount}`);
    }
  }
});
