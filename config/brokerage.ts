// ---- Brokerage configuration (profile-driven, date-aware) ----
//
// Brokerage is NEVER hard-coded inside React components. Every rate lives
// here; changing a profile immediately changes what the charge engine,
// calculator, order form and demo engine compute — no UI code edits.
//
// Profiles carry an effectiveFrom date. To change brokerage, APPEND a new
// profile with a later effectiveFrom — never edit history, so old snapshots
// stay reproducible.

export type BrokerageSegment = 'EQUITY_INTRADAY' | 'EQUITY_DELIVERY';
export type BrokeragePricingType = 'PERCENTAGE' | 'FLAT_PER_ORDER';

export interface BrokerageProfile {
  /** Human-readable identity of this pricing plan. */
  profileName: string;
  segment: BrokerageSegment;
  /** Products this profile applies to (matched case-insensitively). */
  products: string[];
  pricingType: BrokeragePricingType;
  /** Fraction of executed turnover for PERCENTAGE plans, e.g. 0.0003 = 0.03%. */
  percentageRate?: number;
  /** Rupees per executed order for FLAT_PER_ORDER plans. */
  flatPerExecutedOrder?: number;
  /** Floor applied after pricing (0 = no floor). */
  minimumBrokerage: number;
  /** Cap applied after pricing (null = uncapped). */
  maximumBrokerage: number | null;
  effectiveFrom: string;
}

/**
 * Project default plan — matches the rates the app has always used
 * (0.03% of turnover per executed order, no floor/cap).
 *
 * Dummy Terminal flat brokerage (₹10 per executed order) is modelled as a
 * separate FLAT_PER_ORDER profile so the charge engine remains the single
 * source of truth — no React hard-coding. To enable flat ₹10 for Dummy,
 * activate the Dummy profile (effectiveFrom in future or via broker param).
 * Real brokers continue to use the percentage profiles above.
 */
export const BROKERAGE_PROFILES: BrokerageProfile[] = [
  {
    profileName: 'Standard Equity Intraday',
    segment: 'EQUITY_INTRADAY',
    products: ['MIS', 'BOF', 'MARGIN'],
    pricingType: 'PERCENTAGE',
    percentageRate: 0.0003,
    minimumBrokerage: 0,
    maximumBrokerage: null,
    effectiveFrom: '2019-07-01',
  },
  {
    profileName: 'Standard Equity Delivery',
    segment: 'EQUITY_DELIVERY',
    products: ['CNC', 'CO', 'MARGIN'],
    pricingType: 'PERCENTAGE',
    percentageRate: 0.0003,
    minimumBrokerage: 0,
    maximumBrokerage: null,
    effectiveFrom: '2019-07-01',
  },
  // Dummy Terminal — flat ₹10 per executed order (configurable business rule).
  // Effective 2024-10-01 onward; kept as percentage fallback before that for
  // historical reproducibility. Activate by passing product + timestamp; when
  // the caller indicates DUMMY mode the resolver can select this profile.
  {
    profileName: 'Dummy Flat ₹10 (Intraday)',
    segment: 'EQUITY_INTRADAY',
    products: ['MIS', 'BOF', 'MARGIN', 'CNC', 'CO'],
    pricingType: 'FLAT_PER_ORDER',
    flatPerExecutedOrder: 10,
    minimumBrokerage: 0,
    maximumBrokerage: 10,
    effectiveFrom: '2099-01-01', // future-dated: opt-in via DUMMY_BROKERAGE_MODE env/config
  },
  {
    profileName: 'Dummy Flat ₹10 (Delivery)',
    segment: 'EQUITY_DELIVERY',
    products: ['MIS', 'BOF', 'MARGIN', 'CNC', 'CO'],
    pricingType: 'FLAT_PER_ORDER',
    flatPerExecutedOrder: 10,
    minimumBrokerage: 0,
    maximumBrokerage: 10,
    effectiveFrom: '2099-01-01',
  },
];

function toIsoDate(ts: string | Date | undefined | null): string {
  if (!ts) return new Date().toISOString().slice(0, 10);
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

function toSegment(product: string): BrokerageSegment {
  const p = String(product || '').trim().toUpperCase();
  return p === 'CNC' || p === 'CO' || p === 'MARGIN' ? 'EQUITY_DELIVERY' : 'EQUITY_INTRADAY';
}

/** When set to 'flat10', Dummy immediately uses the ₹10 flat profile (2099 entries become active). */
export const DUMMY_BROKERAGE_MODE: 'percentage' | 'flat10' =
  (typeof process !== 'undefined' && (process.env as Record<string, string | undefined>).NEXT_PUBLIC_DUMMY_BROKERAGE_MODE === 'flat10')
    ? 'flat10' : 'percentage';

function isFlatDummyActive(iso: string): boolean {
  if (DUMMY_BROKERAGE_MODE === 'flat10') return true;
  // Also auto-activate when env flag is set at runtime (python-service can inject via window flag)
  try {
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__DUMMY_FLAT_BROKERAGE__ === true) return true;
  } catch {}
  return false;
}

/** Newest profile whose effectiveFrom <= tradeDate and product list matches. */
export function resolveBrokerageProfile(params: {
  product?: string;
  timestamp?: string | Date | null;
  broker?: string | null;
}): { profile: BrokerageProfile; segment: BrokerageSegment; effectiveDate: string } {
  const segment = toSegment(params.product ?? '');
  const productKey = String(params.product ?? '').trim().toUpperCase();
  const iso = toIsoDate(params.timestamp);
  const brokerKey = String(params.broker ?? '').trim().toUpperCase();
  const useDummyFlat = brokerKey === 'DUMMY' || brokerKey === 'DEMO' || isFlatDummyActive(iso);

  let applicable = BROKERAGE_PROFILES.filter(
    (p) =>
      p.segment === segment &&
      (p.products.length === 0 || p.products.includes(productKey)) &&
      p.effectiveFrom <= iso,
  );
  // If dummy flat is explicitly requested, prefer flat profiles regardless of future date.
  if (useDummyFlat) {
    const flat = BROKERAGE_PROFILES.filter(
      (p) => p.pricingType === 'FLAT_PER_ORDER' && p.flatPerExecutedOrder === 10 && p.segment === segment,
    );
    if (flat.length > 0) applicable = [...flat, ...applicable];
  }
  // Newest matching entry wins; fall back to any profile for the segment so a
  // mis-dated product list never yields "no plan" (brokerage would vanish).
  // Fallback excludes future-dated dummy flat unless explicitly requested.
  const fallbackPool = BROKERAGE_PROFILES.filter((p) => {
    if (p.segment !== segment) return false;
    if (p.effectiveFrom > iso) return false;
    if (!useDummyFlat && p.pricingType === 'FLAT_PER_ORDER' && p.flatPerExecutedOrder === 10) return false;
    return true;
  });
  const pool = applicable.length > 0 ? applicable : fallbackPool;
  const profile = [...pool].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return {
    profile,
    segment,
    effectiveDate: profile?.effectiveFrom ?? iso,
  };
}
