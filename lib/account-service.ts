// ---- Account service (Phase: Account redesign) ----
//
// SINGLE data path for the Account page:
//
//   Kotak Neo API (/funds -> RMS limits)  ─┐
//   Demo engine (virtual account)        ─┤
//                                         ├─> normalize*() ─> AccountFunds/
//   System status (/api/system)          ─┘    FundsTransaction  ─> UI cards
//
// Rules enforced here (never in components):
//   * Missing broker value  -> null  -> UI renders "N/A".
//   * Explicit broker zero  -> 0     -> UI renders "₹0.00".
//   * Derived metrics (total balance, utilisation %) are flagged so the UI can
//     label them "Calculated" instead of pretending the broker sent them.
//   * No credentials ever pass through this layer to the UI.

import { useSyncExternalStore, useCallback, useEffect, useRef, useState } from 'react';
import { getFunds, getDemoAccount, getDemoTransactions, getDemoTransactionDetail, getDemoDailyReport, getSystemStatus } from '@/lib/api';
import { getSettingsStore, type AccountMode } from '@/lib/settings-store';

// ---------------------------------------------------------------------------
// Normalized internal types
// ---------------------------------------------------------------------------

export type AccountFundsSource = 'kotak-neo' | 'demo-engine';

/** null means "the broker did not provide this field" — never render as ₹0. */
export interface AccountFunds {
  totalBalance: number | null;
  availableMargin: number | null;
  utilisedMargin: number | null;
  cashComponent: number | null;
  collateralValue: number | null;
  blockedMargin: number | null;
  withdrawableAmount: number | null;
  /** Percentage 0-100. */
  marginUtilisation: number | null;
  currency: string;
  timestamp: string;
  source: AccountFundsSource;
  /** Field names computed locally from other broker fields ("Calculated"). */
  derivedFields: ReadonlyArray<string>;
}

export type FundsTxnType =
  | 'DEPOSIT' | 'WITHDRAWAL' | 'CREDIT' | 'DEBIT' | 'CHARGE' | 'ADJUSTMENT';

export type FundsTxnStatus = 'COMPLETED' | 'PENDING' | 'FAILED';

export interface FundsTransaction {
  id: string;
  type: FundsTxnType;
  /** Signed: positive = money added, negative = money removed. */
  amount: number;
  currency: string;
  status: FundsTxnStatus;
  ts: string;
  reference: string | null;
  description: string | null;
  balanceAfter: number | null;
  source: AccountFundsSource;
}

export interface AccountStatus {
  /** Kotak Neo login/session state; null when unknown. */
  kotakConnected: boolean | null;
  /** Last successful funds fetch timestamp; null when never synced. */
  fundsLastSync: string | null;
  /** Shared backend market-data websocket; null when unknown. */
  marketDataLive: boolean | null;
  mode: AccountMode;
}

// ---------------------------------------------------------------------------
// Configurable margin-utilisation thresholds (never hard-coded in JSX)
// ---------------------------------------------------------------------------

export const MARGIN_UTILISATION_THRESHOLDS = {
  /** >= medium% of total margin used -> MEDIUM (amber). */
  medium: 50,
  /** >= high% of total margin used -> HIGH (red). */
  high: 80,
} as const;

export type MarginUtilisationState = 'LOW' | 'MEDIUM' | 'HIGH';

export function marginUtilisationState(pct: number | null | undefined): MarginUtilisationState {
  if (pct == null || !Number.isFinite(pct)) return 'LOW';
  if (pct >= MARGIN_UTILISATION_THRESHOLDS.high) return 'HIGH';
  if (pct >= MARGIN_UTILISATION_THRESHOLDS.medium) return 'MEDIUM';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pick the first candidate that is an explicit finite number.
 * Strings are parsed only when they actually contain a number, so absent or
 * blank broker fields become null (N/A), never 0.
 */
function pickNum(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const n = typeof c === 'number' ? c : Number(String(c).trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Raw Kotak Neo RMS limits payload -> normalized AccountFunds. */
export function normalizeAccountFunds(raw: unknown): AccountFunds {
  const flat = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, any>)
    : {};
  const rms = flat?.data?.limitObject?.RMS ?? flat?.limitObject?.RMS ?? null;

  const availableMargin = pickNum(rms?.available_margin, flat.Net);
  const utilisedMargin = pickNum(
    rms?.utilised_debit, rms?.used_margin, flat.MarginUsed, flat.AmountUtilizedPrsnt,
  );
  const cashComponent = pickNum(rms?.cash_margin_available, flat.NotionalCash);
  const collateralValue = pickNum(
    rms?.collateral_margin, flat.CollateralValue, flat.Collateral, flat.RmsCollateral,
  );
  // Kotak RMS does not always expose a dedicated blocked-margin figure —
  // keep null (N/A) unless explicitly provided by the broker response.
  const blockedMargin = pickNum(rms?.blocked_margin, rms?.margin_blocked);
  const withdrawableAmount = pickNum(rms?.withdrawable_balance, rms?.withdrawable_amount);

  // Total balance is DERIVED (available + utilised) and labelled as such.
  const derivedFields: string[] = [];
  let totalBalance: number | null = null;
  if (availableMargin != null && utilisedMargin != null) {
    totalBalance = r2(availableMargin + utilisedMargin);
    derivedFields.push('totalBalance');
  }

  // Utilisation % is DERIVED from utilised vs total margin.
  let marginUtilisation: number | null = null;
  if (totalBalance != null && totalBalance > 0 && utilisedMargin != null && utilisedMargin >= 0) {
    marginUtilisation = Math.min(100, Math.max(0, (utilisedMargin / totalBalance) * 100));
    if (!derivedFields.includes('marginUtilisation')) derivedFields.push('marginUtilisation');
  }

  return {
    totalBalance,
    availableMargin,
    utilisedMargin,
    cashComponent,
    collateralValue,
    blockedMargin,
    withdrawableAmount,
    marginUtilisation,
    currency: 'INR',
    timestamp: new Date().toISOString(),
    source: 'kotak-neo',
    derivedFields,
  };
}

type DemoTxnLike = {
  id?: string;
  transaction_id?: string;
  type: string;
  subtype?: string | null;
  amount: number;
  direction?: string | null;
  balanceAfter?: number;
  balanceBefore?: number;
  timestamp: string;
  status: string;
  note?: string | null;
  description?: string | null;
  symbol?: string | null;
  orderId?: string | null;
  positionId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  tradingDate?: string | null;
  metadata?: Record<string, unknown> | null;
};

// Extended ledger entry — preserves legacy FundsTransaction but adds authoritative fields per spec §6
export interface LedgerEntry extends FundsTransaction {
  subtype: string | null;
  direction: 'CREDIT' | 'DEBIT';
  balanceBefore: number | null;
  symbol: string | null;
  orderId: string | null;
  positionId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  tradingDate: string | null;
  metadata: Record<string, unknown> | null;
}

export interface DailyReport {
  date: string;
  openingBalance: number;
  deposits: number;
  withdrawals: number;
  grossRealizedPnl: number;
  totalCharges: number;
  netRealizedPnl: number;
  openingEquity: number;
  closingEquity: number;
  peakEquity: number | null;
  lowestEquity: number | null;
  unrealizedPnl: number;
  orders: number;
  filledOrders: number;
  rejectedOrders: number;
  cancelledOrders: number;
  openPositions: number;
  closedPositions: number;
}

const DEMO_TYPE_MAP: Record<string, FundsTxnType> = {
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
  ORDER_CHARGE: 'CHARGE',
  CHARGE: 'CHARGE',
  TRADE_REALIZED_PNL: 'CREDIT', // mapped dynamically by direction
};

function toDirection(raw: DemoTxnLike): 'CREDIT' | 'DEBIT' {
  const d = String(raw.direction ?? '').toUpperCase();
  if (d === 'CREDIT' || d === 'DEBIT') return d as 'CREDIT' | 'DEBIT';
  // Legacy fallback: DEPOSIT/CREDIT = CREDIT, else DEBIT if amount negative or WITHDRAWAL/CHARGE
  const t = String(raw.type ?? '').toUpperCase();
  if (t === 'DEPOSIT' || t === 'CREDIT') return 'CREDIT';
  if (t === 'WITHDRAWAL' || t === 'DEBIT' || t === 'CHARGE') return 'DEBIT';
  // Trade realized: direction drives
  return Number(raw.amount) < 0 ? 'DEBIT' : 'CREDIT';
}

/** Demo-engine ledger entry -> normalized FundsTransaction / LedgerEntry. */
export function normalizeFundsTransaction(raw: DemoTxnLike): FundsTransaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const rawType = String((raw as Record<string, unknown>).type ?? '').toUpperCase();
  let type: FundsTxnType = DEMO_TYPE_MAP[rawType] ?? 'ADJUSTMENT';
  // Trade realized pnl should keep CREDIT/DEBIT by direction, not CHARGE
  if (rawType === 'TRADE_REALIZED_PNL') {
    type = toDirection(raw as DemoTxnLike) === 'CREDIT' ? 'CREDIT' : 'DEBIT';
  }
  const amount = Number((raw as Record<string, unknown>).amount);
  if (!Number.isFinite(amount)) return null;
  const status = String((raw as Record<string, unknown>).status ?? '').toUpperCase();
  const tsRaw = (raw as Record<string, unknown>).timestamp as string | undefined;
  const ts = tsRaw ? new Date(tsRaw) : new Date();
  return {
    id: String((raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).transaction_id ?? ''),
    type,
    amount,
    currency: 'INR',
    status: status === 'PENDING' ? 'PENDING' : status === 'FAILED' ? 'FAILED' : 'COMPLETED',
    ts: isNaN(ts.getTime()) ? new Date().toISOString() : ts.toISOString(),
    reference: (raw as Record<string, unknown>).orderId as string | null ?? (raw as Record<string, unknown>).referenceId as string | null ?? null,
    description: (raw as Record<string, unknown>).description as string | null ?? (raw as Record<string, unknown>).note as string | null ?? null,
    balanceAfter: pickNum((raw as Record<string, unknown>).balanceAfter),
    source: 'demo-engine',
  };
}

export function normalizeLedgerEntry(raw: DemoTxnLike): LedgerEntry | null {
  const base = normalizeFundsTransaction(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  return {
    ...base,
    subtype: (r.subtype as string | null) ?? null,
    direction: toDirection(raw),
    balanceBefore: pickNum(r.balanceBefore),
    symbol: (r.symbol as string | null) ?? null,
    orderId: (r.orderId as string | null) ?? null,
    positionId: (r.positionId as string | null) ?? null,
    referenceType: (r.referenceType as string | null) ?? null,
    referenceId: (r.referenceId as string | null) ?? null,
    tradingDate: (r.tradingDate as string | null) ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Service API
// ---------------------------------------------------------------------------

async function demoAccountFunds(): Promise<AccountFunds> {
  const res = await getDemoAccount();
  const a = res?.account ?? {};
  const totalBalance = r2(Number(a.balance) || 0);
  const utilisedMargin = r2(Math.max(0, Number(a.usedMargin) || 0));
  const availableMargin = r2(Number(a.freeMargin) || 0);
  return {
    totalBalance,
    availableMargin,
    utilisedMargin,
    cashComponent: totalBalance,      // dummy money is all cash
    collateralValue: 0,               // no pledged holdings in demo
    blockedMargin: 0,                 // nothing separately blocked in demo
    withdrawableAmount: availableMargin,
    marginUtilisation:
      totalBalance > 0
        ? Math.min(100, Math.max(0, (utilisedMargin / totalBalance) * 100))
        : 0,
    currency: 'INR',
    timestamp: new Date().toISOString(),
    source: 'demo-engine',
    derivedFields: ['withdrawableAmount', 'marginUtilisation'],
  };
}

/** Mode-aware funds fetch. API MODE returns REAL Kotak RMS data only. */
export async function getAccountFunds(mode?: AccountMode): Promise<AccountFunds> {
  const m = mode ?? getSettingsStore().getMode();
  if (m === 'demo') return demoAccountFunds();
  try {
    const res = await getFunds();
    return normalizeAccountFunds(res);
  } catch (err) {
    // Surface the failure distinctly so the UI keeps STALE last-known values
    // instead of silently showing empty numbers.
    const e = new Error(
      err instanceof Error ? err.message : 'Kotak Neo funds request failed',
    );
    (e as Error & { kotakError?: boolean }).kotakError = true;
    throw e;
  }
}

/**
 * Mode-aware funds history.
 *
 * API MODE: the current Kotak Neo integration exposes ONLY the RMS limits
 * snapshot (`client.limits()`); there is NO ledger/deposit/withdrawal history
 * endpoint wired into the backend, so this returns [] — the UI shows the honest
 * "not available from broker" state rather than fabricated rows.
 *
 * DEMO MODE: the server-side Dummy Trading Engine maintains the funds ledger
 * (deposits, withdrawals) which is returned here.
 */
export async function getFundsHistory(mode?: AccountMode): Promise<FundsTransaction[]> {
  const m = mode ?? getSettingsStore().getMode();
  if (m === 'api') return [];
  const res = await getDemoTransactions();
  const txns: any[] = Array.isArray(res?.data) ? res.data : [];
  return txns
    .map((t: any) => normalizeFundsTransaction(t))
    .filter((t): t is FundsTransaction => t != null);
}

export async function getLedgerTransactions(params: {
  limit?: number; offset?: number; type?: string; direction?: string; search?: string; from?: string; to?: string; tradingDate?: string;
} = {}): Promise<{ data: LedgerEntry[]; total: number }> {
  const res = await getDemoTransactions(params as Record<string, string | number | undefined>);
  const raw: any[] = Array.isArray(res?.data) ? res.data : [];
  const entries = raw.map((t) => normalizeLedgerEntry(t)).filter((t): t is LedgerEntry => t != null);
  return { data: entries, total: Number(res?.total ?? entries.length) };
}

export async function getTransactionDetail(id: string): Promise<LedgerEntry | null> {
  try {
    const res = await getDemoTransactionDetail(id);
    const raw = res?.data;
    if (!raw) return null;
    return normalizeLedgerEntry(raw);
  } catch { return null; }
}

export async function getDailyReport(date?: string): Promise<DailyReport | null> {
  try {
    const res = await getDemoDailyReport(date);
    if (!res || res.stat === 'NotOk') return null;
    // Already matches DailyReport shape
    return res as DailyReport;
  } catch { return null; }
}

/** Safe connection status only — never credentials. */
export async function getAccountStatus(): Promise<AccountStatus> {
  const store = getSettingsStore();
  const mode = store.getMode();
  if (mode === 'demo') {
    return { kotakConnected: null, fundsLastSync: null, marketDataLive: null, mode };
  }
  try {
    const sys = await getSystemStatus();
    return {
      kotakConnected: Boolean(sys?.pythonStatus?.logged_in),
      fundsLastSync: typeof sys?.timestamp === 'string' ? sys.timestamp : null,
      marketDataLive: Boolean(sys?.websocketConnected),
      mode,
    };
  } catch {
    return { kotakConnected: false, fundsLastSync: null, marketDataLive: null, mode };
  }
}

// ---------------------------------------------------------------------------
// ONE centralized refresh manager (hook)
// ---------------------------------------------------------------------------

export type Freshness = 'live' | 'stale' | 'offline';

/** Consider funds data stale after this long without a successful refresh. */
export const ACCOUNT_STALE_MS = 60_000;

export interface UseAccountDataResult {
  mode: AccountMode;
  funds: AccountFunds | null;
  history: FundsTransaction[];
  status: AccountStatus | null;
  loading: boolean;
  error: string | null;
  kotakError: boolean;
  lastSuccessAt: number | null;
  freshness: Freshness;
  now: number;
  refresh: () => Promise<void>;
}

/**
 * Single owner of ALL account polling: one interval drives funds + status +
 * history. Every card on the page subscribes to THIS state — no card issues
 * its own requests.
 */
export function useAccountData(pollMs = 30_000): UseAccountDataResult {
  const [mode, setMode] = useState<AccountMode>(() => getSettingsStore().getMode());
  const [funds, setFunds] = useState<AccountFunds | null>(null);
  const [history, setHistory] = useState<FundsTransaction[]>([]);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kotakError, setKotakError] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current) return; // prevent duplicate simultaneous requests
    busyRef.current = true;
    const m = getSettingsStore().getMode();
    setLoading(true);
    try {
      const [fundsRes, statusRes] = await Promise.allSettled([
        getAccountFunds(m),
        getAccountStatus(),
      ]);
      if (!mountedRef.current) return;

      if (statusRes.status === 'fulfilled') setStatus(statusRes.value);

      if (fundsRes.status === 'fulfilled') {
        setFunds(fundsRes.value);
        setError(null);
        setKotakError(false);
        setLastSuccessAt(Date.now());
      } else {
        setError(fundsRes.reason instanceof Error ? fundsRes.reason.message : 'Failed to load');
        setKotakError(Boolean((fundsRes.reason as any)?.kotakError));
        // Keep previous funds visible, clearly marked STALE by freshness.
      }

      // History only changes through user actions in demo mode; refresh it
      // alongside so the ledger stays in sync after add/withdraw.
      try {
        const h = await getFundsHistory(m);
        if (mountedRef.current) setHistory(h);
      } catch { /* history is best-effort */ }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Initial load + reload on global mode change.
  useEffect(() => {
    setFunds(null);
    setHistory([]);
    setStatus(null);
    setError(null);
    setKotakError(false);
    setLastSuccessAt(null);
    refresh();
    const store = getSettingsStore();
    const unsub = store.subscribe(() => {
      const next = store.getMode();
      setMode(next);
      refresh();
    });
    return unsub;
  }, [refresh]);

  // ONE shared polling interval (no per-card timers).
  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) refresh();
    }, Math.max(10_000, pollMs));
    return () => clearInterval(interval);
  }, [refresh, pollMs]);

  // Heartbeat so LIVE -> STALE transitions re-render even without new data.
  useEffect(() => {
    const t = setInterval(() => {
      if (mountedRef.current) setNow(Date.now());
    }, 5_000);
    return () => clearInterval(t);
  }, []);

  const freshness: Freshness = (() => {
    if (mode === 'api' && error != null && lastSuccessAt == null) return 'offline';
    if (lastSuccessAt != null && now - lastSuccessAt <= ACCOUNT_STALE_MS) return 'live';
    return 'stale';
  })();

  return { mode, funds, history, status, loading, error, kotakError, lastSuccessAt, freshness, now, refresh };
}
