import type { DummySuggestion, SuggestionCheck } from '@/lib/dummy';

export type SuggestionFilter = 'ALL' | string;

export type SuggestionActionKind = 'process' | 'reject' | 'delete';

export type SuggestionActionState = {
  kind: SuggestionActionKind | null;
  busy: boolean;
  error: string | null;
};

/** One row's mutable in-flight state keyed by suggestion id. */
export type SuggestionActionMap = Record<string, SuggestionActionState>;

export type ReceiveDraft = {
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: string;
  entry: string;
  target: string;
  stopLoss: string;
  confidence: string;
  model: string;
  source: string;
  reason: string;
  product: string;
  orderType: string;
};

export const defaultReceiveDraft = (): ReceiveDraft => ({
  symbol: '',
  direction: 'BUY',
  quantity: '1',
  entry: '',
  target: '',
  stopLoss: '',
  confidence: '50',
  model: '',
  source: 'KHUMBHA_AI',
  reason: '',
  product: 'MIS',
  orderType: 'MKT',
});

export function passesAllChecks(check: SuggestionCheck): boolean {
  return Boolean(check.passed);
}

export const TERMINAL_STAGES = new Set([
  'REJECTED', 'DUPLICATE', 'EXPIRED', 'RISK_REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED',
]);

const CANONICAL_ORDER = ['RESULT', 'NOTIFICATION', 'AUDIT'] as const;

/** Pure state derivation for one pipeline stage from the server's live record. */
export function suggestionStageState(
  stage: string,
  status: string,
  pipeline: string[],
): 'visited' | 'active' | 'pending' | 'skipped' {
  const visited = new Set((pipeline || []).map((p) => String(p).toUpperCase()));
  const st = (status || '').toUpperCase();
  if (TERMINAL_STAGES.has(st)) {
    const idx = st === 'EXECUTED' ? CANONICAL_ORDER.indexOf('RESULT') : -1;
    return idx >= 0 && stage === CANONICAL_ORDER[idx] ? 'active' : 'skipped';
  }
  if (stage === 'RECEIVED' && st === 'RECEIVED') return 'active';
  if (st === 'VALIDATING' && stage === 'VALIDATING') return 'active';
  if (st === 'EXECUTING' && stage === 'EXECUTING') return 'active';
  if (st === 'VALIDATED' && stage === 'VALIDATED') return 'active';
  if (visited.has(stage)) return 'visited';
  return 'pending';
}

export type { DummySuggestion, SuggestionCheck };