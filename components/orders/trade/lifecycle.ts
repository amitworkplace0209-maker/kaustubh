'use client';

/** Pre-execution lifecycle stages the ticket walks through while the order is
 *  in flight. These mirror the Order Engine pipeline (Risk → Audit → Adapter);
 *  the RESULT is the real status the adapter returned — never fabricated. */

export const PRE_EXEC_STAGES: { id: string; label: string }[] = [
  { id: 'CREATED', label: 'Created' },
  { id: 'VALIDATING', label: 'Validating' },
  { id: 'RISK_CHECK', label: 'Risk check' },
  { id: 'SUBMITTING', label: 'Submitting' },
];

/** Map a raw adapter/demo status to the canonical UI status vocabulary.
 *  Unrecognized statuses are returned verbatim (never coerced to a lie). */
export function canonicalOrderStatus(raw: string | null | undefined): string {
  const s = String(raw || '').toUpperCase();
  switch (s) {
    case 'COMPLETE':
    case 'COMPLETED':
    case 'FILLED':
      return 'FILLED';
    case 'PARTIAL':
    case 'PARTIAL_FILL':
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'OPEN':
    case 'PENDING':
    case 'RESTING':
    case 'TRIGGER_PENDING':
      return 'OPEN';
    case 'CANCEL_PENDING':
      return 'CANCEL_PENDING';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELLED';
    case 'REJECT':
    case 'REJECTED':
      return 'REJECTED';
    default:
      // Handles '', 'UNKNOWN', and anything unanticipated — shown plainly.
      return s || 'UNKNOWN';
  }
}

export function execTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'FILLED':
      return 'success';
    case 'PARTIALLY_FILLED':
    case 'CANCELLED':
    case 'CANCEL_PENDING':
      return 'warning';
    case 'REJECTED':
      return 'danger';
    case 'OPEN':
      return 'info';
    default:
      return 'neutral';
  }
}

export const VALIDITIES = ['DAY', 'IOC'] as const;