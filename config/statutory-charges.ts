// ---- Statutory charge configuration (date-aware, exchange-aware) ----
//
// Every rate carries an effectiveFrom date. The resolver picks the newest
// entry whose effectiveFrom <= the trade date, so government/exchange rate
// changes are handled by APPENDING a new entry — never by editing history.
// All rates are fractions of turnover unless the unit says otherwise.

export type EquitySegment = 'EQUITY_INTRADAY' | 'EQUITY_DELIVERY';

export interface DatedRate {
  /** ISO date (inclusive) from which this rate applies. */
  effectiveFrom: string;
  /** ISO date (exclusive) after which this rate stops applying, if retired. */
  effectiveTo?: string | null;
  /** Fraction of applicable turnover, e.g. 0.00025 = 0.025%. */
  rate: number;
}

export type SttRule = {
  segment: EquitySegment;
  /** Sides on which STT applies for this segment. */
  sides: Array<'BUY' | 'SELL'>;
  rates: DatedRate[];
};

export type ExchangeName = 'NSE' | 'BSE';

export const STT_CONFIG: SttRule[] = [
  {
    segment: 'EQUITY_INTRADAY',
    sides: ['SELL'],
    rates: [{ effectiveFrom: '2019-07-01', rate: 0.00025 }],
  },
  {
    segment: 'EQUITY_DELIVERY',
    sides: ['BUY', 'SELL'],
    rates: [
      { effectiveFrom: '2024-10-01', rate: 0.001 },
      { effectiveFrom: '2019-07-01', rate: 0.001 },
    ],
  },
];

export type ExchangeChargesConfig = Record<
  ExchangeName,
  { EQUITY_CASH: DatedRate[] }
>;

export const EXCHANGE_CHARGES_CONFIG: ExchangeChargesConfig = {
  NSE: {
    EQUITY_CASH: [
      { effectiveFrom: '2024-10-01', rate: 0.0000297 },
      { effectiveFrom: '2022-07-05', rate: 0.0000325 },
    ],
  },
  BSE: {
    EQUITY_CASH: [
      { effectiveFrom: '2024-10-01', rate: 0.0000375 },
      { effectiveFrom: '2019-07-01', rate: 0.0000375 },
    ],
  },
};

/** SEBI turnover fee: Rs 10 per crore of turnover. */
export const SEBI_TURNOVER_FEE: DatedRate[] = [
  { effectiveFrom: '2019-07-01', rate: 0.000001 },
];

export const GST_RATE: DatedRate[] = [
  { effectiveFrom: '2017-07-01', rate: 0.18 },
];

/**
 * Stamp duty: BUY side only (both segments), rate differs by delivery type.
 * Source: Indian Stamp Act, amended rates effective 2020-07-01.
 */
export const STAMP_DUTY_CONFIG: Record<EquitySegment, DatedRate[]> = {
  EQUITY_INTRADAY: [{ effectiveFrom: '2020-07-01', rate: 0.00003 }],
  EQUITY_DELIVERY: [{ effectiveFrom: '2020-07-01', rate: 0.00015 }],
};

function resolveDated(entries: DatedRate[], tradeDate: string): number {
  const d = tradeDate || new Date().toISOString().slice(0, 10);
  const sorted = [...entries].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return sorted.find((e) => e.effectiveFrom <= d && (!e.effectiveTo || d < e.effectiveTo))?.rate ?? 0;
}

function toIsoDate(ts: string | Date | undefined | null): string {
  if (!ts) return new Date().toISOString().slice(0, 10);
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function toSegment(product: string): EquitySegment {
  const p = String(product || '').trim().toUpperCase();
  // CNC / CO-with-delivery /Margin products settle to delivery; MIS/BOF are intraday.
  return p === 'CNC' || p === 'CO' || p === 'MARGIN' ? 'EQUITY_DELIVERY' : 'EQUITY_INTRADAY';
}

function toExchange(exchange: string): ExchangeName {
  return String(exchange || '').trim().toUpperCase().startsWith('BSE') ? 'BSE' : 'NSE';
}

export function latestApplicable(entries: DatedRate[], iso: string): DatedRate | undefined {
  return [...entries]
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
    .find((e) => e.effectiveFrom <= iso && (!e.effectiveTo || iso < e.effectiveTo));
}

export function resolveSttRate(params: {
  product: string;
  side: 'BUY' | 'SELL';
  timestamp?: string | Date | null;
}): { rate: number; segment: EquitySegment; effectiveFrom: string } {
  const segment = toSegment(params.product);
  const rule = STT_CONFIG.find((r) => r.segment === segment);
  const iso = toIsoDate(params.timestamp);
  const hit = rule ? latestApplicable(rule.rates, iso) : undefined;
  const applies = Boolean(rule && rule.sides.includes(params.side));
  return { rate: hit && applies ? hit.rate : 0, segment, effectiveFrom: hit?.effectiveFrom ?? '' };
}

export function resolveExchangeTxnRate(params: {
  exchange: string;
  timestamp?: string | Date | null;
}): { rate: number; effectiveFrom: string } {
  const exch = EXCHANGE_CHARGES_CONFIG[toExchange(params.exchange)].EQUITY_CASH;
  const iso = toIsoDate(params.timestamp);
  const hit = latestApplicable(exch, iso);
  return { rate: hit?.rate ?? 0, effectiveFrom: hit?.effectiveFrom ?? '' };
}

export function resolveSebiRate(timestamp?: string | Date | null): { rate: number; effectiveFrom: string } {
  const iso = toIsoDate(timestamp);
  const hit = latestApplicable(SEBI_TURNOVER_FEE, iso);
  return { rate: hit?.rate ?? 0, effectiveFrom: hit?.effectiveFrom ?? '' };
}

export function resolveGstRate(timestamp?: string | Date | null): { rate: number; effectiveFrom: string } {
  const iso = toIsoDate(timestamp);
  const hit = latestApplicable(GST_RATE, iso);
  return { rate: hit?.rate ?? 0, effectiveFrom: hit?.effectiveFrom ?? '' };
}

export function resolveStampDutyRate(params: {
  product: string;
  side: 'BUY' | 'SELL';
  timestamp?: string | Date | null;
}): { rate: number; segment: EquitySegment; effectiveFrom: string } {
  const segment = toSegment(params.product);
  if (params.side !== 'BUY') {
    return { rate: 0, segment, effectiveFrom: STAMP_DUTY_CONFIG[segment][0]?.effectiveFrom ?? '' };
  }
  const iso = toIsoDate(params.timestamp);
  const hit = latestApplicable(STAMP_DUTY_CONFIG[segment], iso);
  return { rate: hit?.rate ?? 0, segment, effectiveFrom: hit?.effectiveFrom ?? '' };
}
