// Central WebSocket Engine — pure UI helpers (FIELD STATUS LABELLING).
//
// Pure module (no React / no fetch) so it is unit-testable on plain node:
//   npm test
//
// The status vocabulary is authoritative: it is the schema-verification set
// returned by the backend `field-verification` payload (and checked in
// `python-service/tests/test_ws_engine.py`). These helpers never invent a
// status — unknown statuses render as a neutral label.

export const STATUS_ORDER = [
  'DIRECT_WS',
  'WS_CONDITIONAL',
  'QUOTE_REST_ONLY',
  'OTHER_API',
  'DERIVED',
  'TARGET_LABEL',
  'NOT_PROVIDED_BY_KOTAK_WS',
  'NOT_VERIFIED',
] as const;

export type FieldStatus = (typeof STATUS_ORDER)[number];

const STATUS_COLORS: Record<string, string> = {
  DIRECT_WS: 'bg-success text-success-foreground',
  WS_CONDITIONAL: 'bg-warning text-warning-foreground',
  QUOTE_REST_ONLY: 'bg-muted text-foreground',
  OTHER_API: 'bg-muted text-foreground',
  DERIVED: 'bg-muted text-foreground',
  TARGET_LABEL: 'bg-primary text-primary-foreground',
  NOT_PROVIDED_BY_KOTAK_WS: 'bg-destructive/70 text-white',
  NOT_VERIFIED: 'bg-destructive text-destructive-foreground',
};

/** `DIRECT_WS` -> `DIRECT WS` (UI-safe, no spaces in data). */
export function statusShort(status: string | undefined | null): string {
  if (!status) return 'UNKNOWN';
  return status.replace(/_/g, ' ');
}

export function statusTone(status: string | undefined | null): string {
  return STATUS_COLORS[status ?? ''] ?? 'bg-muted text-muted-foreground';
}

export interface FieldRow {
  num: number;
  field: string;
  category: string;
  status: string;
  kotak_attr: string;
  feed_level: string;
  direct_derived: string;
  evidence?: string;
  notes?: string;
}

/**
 * Filter verification rows. Empty status filter = show all; `query` matches
 * field name, kotak attribute and numeric index (case-insensitive).
 * Never mutates the caller's rows.
 */
export function fieldRowsFiltered(rows: FieldRow[], status: string, query: string): FieldRow[] {
  let out = rows;
  if (status && status !== 'ALL') out = out.filter((r) => r.status === status);
  const q = (query ?? '').trim().toLowerCase();
  if (q) {
    out = out.filter((r) =>
      `${r.field} ${r.kotak_attr} ${r.num} ${r.category}`.toLowerCase().includes(q),
    );
  }
  return out.slice(0, 120);
}

/** Ordered `[{status, count}]` for non-zero statuses, following STATUS_ORDER. */
export function countsByStatus(counts: Record<string, number>): { status: string; count: number }[] {
  if (!counts) return [];
  return STATUS_ORDER
    .filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => ({ status: s, count: counts[s] ?? 0 }));
}

/** Human label for a resource severity. Unknown -> UNKNOWN (never fake). */
export function severityTone(severity: string | undefined | null): string {
  if (severity === 'EMERGENCY' || severity === 'CRITICAL') {
    return 'bg-destructive text-destructive-foreground';
  }
  if (severity === 'HIGH') return 'bg-warning text-warning-foreground';
  return 'bg-muted text-muted-foreground';
}