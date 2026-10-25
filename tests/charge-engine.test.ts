// ---- Canonical charge engine unit tests (Phase 23) ----
//
// Runs on plain node (>=22.6 runs .ts natively):  npm test
// Pure modules only â€” imported via RELATIVE paths so no tsconfig path
// aliasing is required outside Next.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALCULATION_VERSION,
  calculateCharges,
  calculateBrokerage,
  calculateSTT,
  calculateExchangeCharges,
  calculateSEBICharges,
  calculateStampDuty,
  calculateGST,
  gstTaxableBase,
  normalizeExecution,
  dedupeExecutions,
  executionKey,
  calculateExecutionCharges,
  isExecutedStatus,
} from '../lib/charge-engine.ts';

import {
  normSymbol,
  positionKey,
  emptyBreakdown,
  estimateFillCharges,
  kotakRowToTrade,
  demoOrderToTrade,
  calculatePositionCharges,
} from '../lib/charge-service.ts';

import { resolveBrokerageProfile } from '../config/brokerage.ts';
import {
  resolveSttRate, resolveStampDutyRate, latestApplicable,
} from '../config/statutory-charges.ts';

const R2 = (n: number) => Math.round(n * 100) / 100;
const NOW = '2024-12-01T10:00:00+05:30';

// ---------------------------------------------------------------------------
// 1-2. Full breakdown: intraday BUY / SELL
// ---------------------------------------------------------------------------

test('intraday BUY 100 x 500 produces the exact configured breakdown', () => {
  const c = calculateCharges({ side: 'BUY', quantity: 100, price: 500, product: 'MIS', timestamp: NOW });
  const turnover = 50_000;
  assert.equal(c.turnover, turnover);
  assert.equal(c.brokerage, R2(turnover * 0.0003));          // 15.00
  assert.equal(c.stt, 0);                                     // STT not levied on intraday BUY
  assert.equal(c.exchangeTransactionCharges, R2(turnover * 0.0000297)); // NSE
  assert.equal(c.sebiCharges, R2(turnover * 0.000001));
  assert.equal(c.stampDuty, R2(turnover * 0.00003));          // buy side only, intraday
  const base = R2(c.brokerage + c.exchangeTransactionCharges + c.sebiCharges);
  assert.equal(c.gstTaxableBase, base);
  assert.equal(c.gst, R2(base * 0.18));
  assert.equal(
    c.totalCharges,
    R2(c.brokerage + c.stt + c.exchangeTransactionCharges + c.sebiCharges + c.stampDuty + c.gst + c.otherCharges),
  );
  assert.equal(c.calculationVersion, CALCULATION_VERSION);
});

test('intraday SELL charges STT on sell side and skips stamp duty', () => {
  const c = calculateCharges({ side: 'SELL', quantity: 100, price: 500, product: 'MIS', timestamp: NOW });
  assert.ok(c.stt > 0, 'sell side must carry intraday STT');
  assert.equal(c.stt, R2(50_000 * 0.00025));
  assert.equal(c.stampDuty, 0, 'stamp duty is buy-side only');
});

// ---------------------------------------------------------------------------
// 3. Delivery CNC: STT both sides at delivery rate
// ---------------------------------------------------------------------------

test('CNC delivery applies delivery STT on BUY and SELL', () => {
  const buy = calculateCharges({ side: 'BUY', quantity: 10, price: 1000, product: 'CNC', timestamp: NOW });
  const sell = calculateCharges({ side: 'SELL', quantity: 10, price: 1000, product: 'CNC', timestamp: NOW });
  assert.equal(buy.stt, R2(10_000 * 0.001));
  assert.equal(sell.stt, R2(10_000 * 0.001));
  // Delivery stamp duty rate is higher than intraday.
  assert.equal(buy.stampDuty, R2(10_000 * 0.015 / 100));
});

// ---------------------------------------------------------------------------
// 4-5. Brokerage rules
// ---------------------------------------------------------------------------

test('brokerage percentage of turnover with minimum floor', () => {
  const tiny = calculateBrokerage({ turnover: 1_000, timestamp: NOW }); // 0.30 -> above min(0)
  assert.equal(tiny.brokerage, 0.3);
  const { profile } = resolveBrokerageProfile({ product: 'MIS', timestamp: NOW });
  assert.ok(profile, 'profile must resolve for MIS');
  assert.equal(profile!.pricingType, 'PERCENTAGE');
});

test('zero-turnover brokerage is zero without errors', () => {
  const r = calculateBrokerage({ turnover: 0, timestamp: NOW });
  assert.equal(r.brokerage, 0);
});

// ---------------------------------------------------------------------------
// 6-8. Degenerate inputs & GST base
// ---------------------------------------------------------------------------

test('zero quantity yields an all-zero breakdown', () => {
  const c = calculateCharges({ side: 'BUY', quantity: 0, price: 500, product: 'MIS', timestamp: NOW });
  assert.equal(c.totalCharges, 0);
  assert.equal(c.turnover, 0);
});

test('zero price yields an all-zero breakdown', () => {
  const c = calculateCharges({ side: 'SELL', quantity: 10, price: 0, product: 'MIS', timestamp: NOW });
  assert.equal(c.totalCharges, 0);
  assert.equal(c.turnover, 0);
});

test('GST taxable base excludes STT and stamp duty', () => {
  const c = calculateCharges({ side: 'BUY', quantity: 50, price: 200, product: 'CNC', timestamp: NOW });
  assert.equal(gstTaxableBase({
    brokerage: c.brokerage,
    exchangeTransactionCharges: c.exchangeTransactionCharges,
    sebiCharges: c.sebiCharges,
    otherCharges: c.otherCharges,
  }), c.gstTaxableBase);
  assert.equal(c.gstTaxableBase, R2(c.brokerage + c.exchangeTransactionCharges + c.sebiCharges + c.otherCharges));
  assert.ok(!(c.gstTaxableBase >= c.stt && c.stt > 0), 'STT must not leak into the GST base');
});

// ---------------------------------------------------------------------------
// 9. Rounding
// ---------------------------------------------------------------------------

test('every monetary part is rounded to 2 decimals', () => {
  const c = calculateCharges({ side: 'BUY', quantity: 7, price: 333.33, product: 'MIS', timestamp: NOW });
  for (const v of [
    c.brokerage, c.stt, c.exchangeTransactionCharges, c.sebiCharges,
    c.stampDuty, c.gst, c.totalCharges, c.turnover, c.gstTaxableBase,
  ]) {
    const scaled = v * 100;
    assert.ok(
      Math.abs(Math.round(scaled) - scaled) < 1e-6,
      `value ${v} must effectively have <=2 decimals`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10-13. Execution normalization + dedupe
// ---------------------------------------------------------------------------

test('normalizeExecution accepts executed rows and rejects non-fills', () => {
  const row = {
    n_ord_no: '12345', trdSym: 'RELIANCE-EQ', exSeg: 'nse_cm', prod: 'MIS',
    trnsTp: 'B', fldQty: '10', avgPrc: '2500.5', status: 'complete',
    flDtTm: '2024-12-01T10:00:00',
  };
  const e = normalizeExecution(row);
  assert.ok(e);
  assert.equal(e!.orderId, '12345');
  assert.equal(e!.side, 'BUY');
  assert.equal(e!.quantity, 10);
  assert.equal(e!.executedPrice, 2500.5);
  assert.equal(e!.executedValue, 25005);

  for (const bad of [
    { ...row, status: 'rejected' },
    { ...row, status: 'cancelled' },
    { ...row, fldQty: '0' },
    { ...row, avgPrc: '0' },
    { ...row, n_ord_no: '' },
  ]) {
    assert.equal(normalizeExecution(bad), null, JSON.stringify(bad));
  }
});

test('isExecutedStatus matches the documented set case-insensitively', () => {
  for (const s of ['COMPLETE', 'Filled', 'EXECUTED', 'partial']) assert.ok(isExecutedStatus(s));
  for (const s of ['open', 'pending', 'rejected', 'cancelled', '', undefined as unknown as string]) {
    assert.equal(isExecutedStatus(s), false);
  }
});

test('dedupeExecutions drops duplicates and keeps the larger fill', () => {
  const a = {
    orderId: 'X1', tradeId: '', side: 'BUY' as const, quantity: 10,
    executedPrice: 100, symbol: 'ABC', exchange: 'NSE', product: 'MIS',
    timestamp: NOW, executedValue: 1000,
  };
  const dupSmall = { ...a, quantity: 5 };
  const b = { ...a, orderId: 'X2', tradeId: 'T9' };
  const out = dedupeExecutions([a, dupSmall, b]);
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.orderId === 'X1')!.quantity, 10);
});

test('executionKey distinguishes trades within one order', () => {
  const k = executionKey({ orderId: 'O1', tradeId: 'T1' });
  assert.ok(k.includes('O1'));
  assert.ok(k.includes('T1'));
  assert.notEqual(k, executionKey({ orderId: 'O1', tradeId: 'T2' }));
});

// ---------------------------------------------------------------------------
// 14. Multi-fill aggregation
// ---------------------------------------------------------------------------

test('calculateExecutionCharges sums multiple fills exactly once each', () => {
  const fills = [
    { orderId: 'A', tradeId: '', side: 'BUY' as const, quantity: 50, executedPrice: 100, symbol: 'ABC', exchange: 'nse_cm', product: 'MIS', timestamp: NOW, executedValue: 5000 },
    { orderId: 'A', tradeId: 't2', side: 'BUY' as const, quantity: 50, executedPrice: 102, symbol: 'ABC', exchange: 'nse_cm', product: 'MIS', timestamp: NOW, executedValue: 5100 },
    { orderId: 'B', tradeId: '', side: 'SELL' as const, quantity: 100, executedPrice: 105, symbol: 'ABC', exchange: 'nse_cm', product: 'MIS', timestamp: NOW, executedValue: 10500 },
  ];
  const agg = calculateExecutionCharges(fills);
  const single = calculateExecutionCharges(fills.slice(0, 2));
  assert.equal(agg.turnover, 20_600);
  // Sell leg carries STT; buys do not (intraday).
  const sellOnly = calculateExecutionCharges(fills.slice(2));
  assert.equal(agg.stt, sellOnly.stt);
  assert.ok(single.totalCharges > 0);
});

// ---------------------------------------------------------------------------
// 15-17. Facade helpers
// ---------------------------------------------------------------------------

test('normSymbol and positionKey are stable and normalized', () => {
  assert.equal(normSymbol('IDBI-EQ'), 'IDBI');
  assert.equal(positionKey(' idbi-eq ', 'mis'), positionKey('IDBI', 'MIS'));
  assert.notEqual(positionKey('IDBI', 'MIS'), positionKey('IDBI', 'CNC'));
});

test('emptyBreakdown returns an all-zero known=false result shape', () => {
  const e = emptyBreakdown();
  for (const v of Object.values(e)) assert.equal(v, 0);
});

test('estimateFillCharges works with and without context', () => {
  const legacy = estimateFillCharges('BUY', 500, 10);
  assert.ok(legacy.totalCharges > 0);
  const ctx = estimateFillCharges('BUY', 500, 10, { product: 'CNC', exchange: 'bse_cm', timestamp: NOW });
  // Delivery BUY carries STT; BSE txn rate differs from NSE.
  assert.ok(ctx.stt > 0);
  assert.notEqual(ctx.exchangeCharges, legacy.exchangeCharges);
});

// ---------------------------------------------------------------------------
// 18-19. Row adapters
// ---------------------------------------------------------------------------

test('kotakRowToTrade maps executed rows and rejects rejected ones', () => {
  const executed = kotakRowToTrade({
    n_ord_no: '777', trdSym_clean: 'TCS-EQ', exSeg_clean: 'nse_cm', prod_clean: 'CNC',
    trnsTp: 'S', fldQty: '5', avgPrc: '3500.25', status: 'COMPLETE',
    flDtTm: '2024-12-02T09:15:00',
  });
  assert.ok(executed);
  assert.equal(executed!.symbol, 'TCS');
  assert.equal(executed!.product, 'CNC');
  assert.equal(executed!.quantity, 5);
  assert.equal(kotakRowToTrade({ n_ord_no: '778', status: 'REJECTED' }), null);
});

test('demoOrderToTrade only converts COMPLETE orders with fills', () => {
  const base = {
    orderId: 'D1', transactionType: 'BUY' as const, averageTradedPrice: 100,
    price: 100, filledQuantity: 10, status: 'COMPLETE', symbol: 'XYZ',
    tradingSymbol: 'XYZ-EQ', product: 'MIS', exchange: 'nse_cm',
    exchangeSegment: 'nse_cm', orderDate: NOW, charges: null,
  };
  const t = demoOrderToTrade(base);
  assert.ok(t);
  assert.equal(t!.quantity, 10);
  assert.equal(demoOrderToTrade({ ...base, status: 'OPEN' }), null);
  assert.equal(demoOrderToTrade({ ...base, filledQuantity: 0 }), null);
});

// ---------------------------------------------------------------------------
// 20. Per-position aggregation
// ---------------------------------------------------------------------------

test('calculatePositionCharges groups by order and flags confirmation', () => {
  const trades = [
    kotakRowToTrade({ n_ord_no: 'P1', trdSym: 'INFY-EQ', prod: 'MIS', trnsTp: 'B', fldQty: '10', avgPrc: '1500', status: 'complete' })!,
    kotakRowToTrade({ n_ord_no: 'P2', trdSym: 'INFY-EQ', prod: 'MIS', trnsTp: 'S', fldQty: '10', avgPrc: '1510', status: 'complete' })!,
  ];
  const res = calculatePositionCharges(trades);
  assert.equal(res.known, true);
  assert.equal(res.confirmed, false, 'no provider charges -> configured estimate');
  assert.ok(res.breakdown.totalCharges > 0);
  assert.ok(res.orderCount >= 1);
});

// ---------------------------------------------------------------------------
// 21. Statutory rate resolvers
// ---------------------------------------------------------------------------

test('statutory resolvers honor effectiveFrom/effectiveTo windows', () => {
  const before = '2018-01-01T00:00:00+05:30';
  assert.ok(resolveSttRate({ product: 'CNC', side: 'BUY', timestamp: before }).rate >= 0);
  const stampIntraBuy = resolveStampDutyRate({ product: 'MIS', side: 'BUY', timestamp: NOW });
  const stampIntraSell = resolveStampDutyRate({ product: 'MIS', side: 'SELL', timestamp: NOW });
  assert.equal(stampIntraSell.rate, 0);
  assert.ok(stampIntraBuy.rate > 0);
});

test('latestApplicable picks the newest window and honors effectiveTo', () => {
  const table = [
    { rate: 1, effectiveFrom: '2020-01-01', effectiveTo: '2021-01-01' },
    { rate: 2, effectiveFrom: '2021-01-01', effectiveTo: null },
    { rate: 3, effectiveFrom: '2022-06-01', effectiveTo: null },
  ];
  assert.equal(latestApplicable(table, '2020-06-01')?.rate, 1);
  assert.equal(latestApplicable(table, '2021-06-01')?.rate, 2);
  assert.equal(latestApplicable(table, '2023-01-01')?.rate, 3);
  assert.equal(latestApplicable(table, '2019-01-01'), undefined);
});

// ---------------------------------------------------------------------------
// 22-24. Component calculators + anchoring
// ---------------------------------------------------------------------------

test('component calculators agree with the aggregate engine', () => {
  const params = { quantity: 25, price: 480, product: 'MIS' as const, timestamp: NOW };
  const agg = calculateCharges({ side: 'BUY', ...params });
  assert.equal(calculateSTT({ product: 'MIS', side: 'BUY', turnover: agg.turnover, timestamp: NOW }), agg.stt);
  assert.equal(calculateExchangeCharges({ exchange: 'nse_cm', turnover: agg.turnover, timestamp: NOW }), agg.exchangeTransactionCharges);
  assert.equal(calculateSEBICharges({ turnover: agg.turnover, timestamp: NOW }), agg.sebiCharges);
  assert.equal(
    calculateGST({
      brokerage: agg.brokerage,
      exchangeTransactionCharges: agg.exchangeTransactionCharges,
      sebiCharges: agg.sebiCharges,
      otherCharges: agg.otherCharges,
      timestamp: NOW,
    }).gst,
    agg.gst,
  );
  assert.equal(
    calculateStampDuty({ product: 'MIS', side: 'BUY', turnover: agg.turnover, timestamp: NOW }),
    agg.stampDuty,
  );
});
