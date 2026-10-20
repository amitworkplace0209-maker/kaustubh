/**
 * Pure helpers for the Tick Analytics page.
 *
 * Everything here is a pure function over backend payloads -- no fetching, no
 * React, no clock reads that could be mistaken for data timestamps. The page
 * and the BFF proxy both import from here so the section contract exists in
 * exactly ONE place.
 *
 * HONESTY CONTRACT
 * ----------------
 * A metric the backend reports as null/undefined is surfaced as null (rendered
 * as an em dash by the UI) -- never as 0, never as an invented number. Every
 * helper that could plausibly default to zero instead returns null and lets the
 * caller show the reason from `missing[]`.
 */

/* -------------------------------------------------------------------------- */
/* Section contract (page <-> BFF <-> backend)                                */
/* -------------------------------------------------------------------------- */

export const SECTIONS = [
  'summary',
  'daily',
  'day',
  'top',
  'symbolStats',
  'report',
  'reports',
  'live',
  'export',
] as const;

export type SectionId = (typeof SECTIONS)[number];

const BACKEND_PREFIX = '/api/data-saver/tick-analytics';

/** Which params are consumed by the path (and therefore never re-sent as query). */
const PATH_PARAM_KEYS: Partial<Record<SectionId, string[]>> = {
  day: ['date'],
  symbolStats: ['symbol'],
};

/** Query params accepted by each section (undefined / empty values dropped). */
const QUERY_PARAM_KEYS: Partial<Record<SectionId, string[]>> = {
  daily: ['days'],
  top: ['date', 'limit', 'offset'],
  symbolStats: ['date'],
  report: ['date'],
  reports: ['days'],
  export: ['date', 'days', 'format'],
};

/** Backend path for a section, plus the query string for that section. */
export function backendPath(section: SectionId, params: Record<string, string | number | undefined> = {}): string {
  const qs = (keys: string[]) => {
    const sp = new URLSearchParams();
    for (const k of keys) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
    const out = sp.toString();
    return out ? `?${out}` : '';
  };

  const pathKeys = PATH_PARAM_KEYS[section] ?? [];
  const queryKeys = (QUERY_PARAM_KEYS[section] ?? []).filter((k) => !pathKeys.includes(k));

  switch (section) {
    case 'summary':
      return `${BACKEND_PREFIX}/summary${qs(queryKeys)}`;
    case 'daily':
      return `${BACKEND_PREFIX}/daily${qs(queryKeys)}`;
    case 'day':
      return `${BACKEND_PREFIX}/daily/${encodeURIComponent(String(params.date ?? ''))}${qs(queryKeys)}`;
    case 'top':
      return `${BACKEND_PREFIX}/top-symbols${qs(queryKeys)}`;
    case 'symbolStats':
      return `${BACKEND_PREFIX}/symbol-stats/${encodeURIComponent(String(params.symbol ?? ''))}${qs(queryKeys)}`;
    case 'report':
      return `${BACKEND_PREFIX}/report${qs(queryKeys)}`;
    case 'reports':
      return `${BACKEND_PREFIX}/reports${qs(queryKeys)}`;
    case 'export':
      return `${BACKEND_PREFIX}/export${qs(queryKeys)}`;
    case 'live':
    default:
      // The live block is assembled from several engine endpoints server-side.
      return `${BACKEND_PREFIX}/state${qs(queryKeys)}`;
  }
}

/** Query string for the BFF route, carrying the section + its params. */
export function sectionQuery(section: SectionId, params: Record<string, string | number | undefined> = {}): string {
  const sp = new URLSearchParams({ section });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const out = sp.toString();
  return out ? `?${out}` : '';
}

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === 'string' && (SECTIONS as readonly string[]).includes(v);
}

/* -------------------------------------------------------------------------- */
/* Numeric / time primitives                                                   */
/* -------------------------------------------------------------------------- */

/** Range key -> seconds. Unknown keys fall back to 5 minutes (backend default). */
export function rangeSec(range: string): number {
  switch (range) {
    case '1m': return 60;
    case '5m': return 300;
    case '15m': return 900;
    case '1h': return 3600;
    case '1d': return 86400;
    default: return 300;
  }
}

/** Any timestamp shape -> epoch ms, or null when genuinely unparseable. */
export function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return v > 1e12 ? v : v * 1000;
  }
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    const anyV = v as Record<string, unknown>;
    if (typeof anyV.$date === 'string') {
      const n = Date.parse(anyV.$date);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

export function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Null-safe formatter: any unmeasurable value renders as an em dash. */
export function honest(v: unknown, suffix = ''): string {
  const n = num(v);
  if (n == null) return '—';
  const s = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
  }).format(n);
  return `${s}${suffix}`;
}

export function fmtNumber(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
}

export function fmtCompactNum(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function fmtRate(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return '—';
  return n >= 100 ? n.toFixed(0) : n.toFixed(2);
}

export function fmtBytes(v: number | null | undefined): string {
  const n = num(v);
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(n);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const sign = n < 0 ? '-' : '';
  return `${sign}${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const IST_TZ = 'Asia/Kolkata';

export function fmtIST(v: unknown, opts?: Intl.DateTimeFormatOptions): string {
  const ms = toMs(v);
  if (ms == null) return '—';
  try {
    return new Date(ms).toLocaleString('en-IN', { timeZone: IST_TZ, ...opts });
  } catch {
    return '—';
  }
}

export function fmtISTTime(v: unknown): string {
  return fmtIST(v, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtISTDate(v: unknown): string {
  return fmtIST(v, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Age in seconds from a backend timestamp to `nowMs` (explicit, never implied). */
export function ageSec(v: unknown, nowMs: number): number | null {
  const ms = toMs(v);
  if (ms == null) return null;
  const delta = Math.round((nowMs - ms) / 1000);
  return Number.isFinite(delta) ? Math.max(0, delta) : null;
}

/* -------------------------------------------------------------------------- */
/* Honesty helpers                                                             */
/* -------------------------------------------------------------------------- */

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

export type MissingList = string[] | null | undefined;

export function missingChips(missing: MissingList): { key: string; label: string }[] {
  if (!missing || missing.length === 0) return [];
  return missing.map((m) => ({
    key: String(m),
    label: MISSING_LABELS[String(m)] ?? String(m).replace(/([A-Z])/g, ' $1').trim().toUpperCase(),
  }));
}

const MISSING_LABELS: Record<string, string> = {
  daily_document: 'DAILY DOCUMENT',
  MONGO_NOT_CONNECTED: 'MONGO NOT CONNECTED',
  ticksReceived: 'TICKS RECEIVED',
  ticksPersisted: 'TICKS PERSISTED',
  activeSymbols: 'ACTIVE SYMBOLS',
  firstTick: 'FIRST TICK',
  lastTick: 'LAST TICK',
  avgTickRate: 'AVG TICK RATE',
  peakTickRate: 'PEAK TICK RATE',
  persistenceSuccessRate: 'PERSISTENCE SUCCESS RATE',
  tickTimeline: 'TICK TIMELINE',
  rateMetrics: 'RATE METRICS',
  storedTickDocuments: 'STORED TICK DOCUMENTS',
};

export type DataStatus = 'COMPLETE' | 'PARTIAL' | 'NO_DATA' | 'BACKFILLING' | 'UNAVAILABLE';

export function statusTone(status: unknown): Tone {
  switch (String(status ?? '').toUpperCase()) {
    case 'COMPLETE': return 'success';
    case 'PARTIAL': return 'warning';
    case 'NO_DATA': return 'neutral';
    case 'BACKFILLING': return 'info';
    case 'UNAVAILABLE': return 'danger';
    default: return 'neutral';
  }
}

export function statusLabel(status: unknown): string {
  const s = String(status ?? '').toUpperCase();
  if (!s) return 'UNKNOWN';
  if (s === 'NO_DATA') return 'NO DATA';
  if (s === 'UNAVAILABLE') return 'UNAVAILABLE';
  return s;
}

/**
 * Effective status of a daily row. A day that is still queued for the
 * background backfill is BACKFILLING -- not "0 ticks", not "no data".
 */
export function dailyRowStatus(row: Record<string, any> | null | undefined, pendingDates?: readonly string[]): DataStatus {
  if (!row) return pendingDates && pendingDates.length > 0 ? 'BACKFILLING' : 'NO_DATA';
  const date = String(row.date ?? '');
  if (pendingDates && pendingDates.includes(date)) return 'BACKFILLING';
  const raw = String(row.status ?? '').toUpperCase();
  if (raw === 'COMPLETE' || raw === 'PARTIAL' || raw === 'NO_DATA' || raw === 'UNAVAILABLE') {
    return raw as DataStatus;
  }
  const storedDocs = num((row.counts as any)?.storedDocs);
  if (storedDocs == null || storedDocs <= 0) return 'NO_DATA';
  return (row.missing as string[])?.length ? 'PARTIAL' : 'COMPLETE';
}

export function persistenceTone(pct: unknown): Tone {
  const n = num(pct);
  if (n == null) return 'neutral';
  if (n >= 99.5) return 'success';
  if (n >= 95) return 'warning';
  return 'danger';
}

export function duplicateTone(pct: unknown): Tone {
  const n = num(pct);
  if (n == null) return 'neutral';
  if (n <= 1) return 'success';
  if (n <= 5) return 'warning';
  return 'danger';
}

/* -------------------------------------------------------------------------- */
/* Chart series builders (pure; never fabricate a point)                       */
/* -------------------------------------------------------------------------- */

export type SeriesPoint = { time: string; value: number | null };

/** Daily table rows -> [{date, ticks}] for the volume chart (null stays null). */
export function dailyChartSeries(rows: readonly Record<string, any>[]): SeriesPoint[] {
  return rows
    .map((r) => {
      const ticks = num((r.ticks as any)?.count) ?? num((r.counts as any)?.persisted);
      return { time: String(r.date ?? ''), value: ticks ?? null };
    })
    .filter((p) => p.time !== '')
    .reverse(); // chart reads oldest -> newest
}

/** Period rows -> [{label, ticks}]. */
export function periodChartSeries(periods: readonly Record<string, any>[]): SeriesPoint[] {
  return periods.map((p) => ({
    time: String(p.label ?? ''),
    value: num(p.ticks) ?? null,
  }));
}

/** Top symbols -> [{symbol, ticks}] chart rows, already backend-ranked. */
export function topSymbolSeries(stats: readonly Record<string, any>[]): { time: string; value: number | null }[] {
  return stats.map((s) => ({
    time: String(s.symbol ?? ''),
    value: num(s.ticks) ?? null,
  }));
}

/** Second-series (rate) -> seconds-of-day axis label helper. */
export function periodDurationSec(periods: readonly Record<string, any>[]): number | null {
  const start = num(periods[0]?.startMinute);
  const end = num(periods[periods.length - 1]?.endMinute);
  if (start == null || end == null || end <= start) return null;
  return (end - start) * 60;
}

/* -------------------------------------------------------------------------- */
/* Report helpers                                                              */
/* -------------------------------------------------------------------------- */

export type ReportStatus = 'COMPLETE' | 'PARTIAL' | 'NO_DATA';

export function reportTone(status: unknown): Tone {
  return statusTone(status);
}

export function reportSummary(report: Record<string, any> | null | undefined): {
  status: ReportStatus;
  complete: boolean;
  missing: { key: string; label: string }[];
  sectionCount: number;
} {
  if (!report) {
    return { status: 'NO_DATA', complete: false, missing: [{ key: 'daily_document', label: 'DAILY DOCUMENT' }], sectionCount: 0 };
  }
  const raw = String(report.status ?? 'NO_DATA').toUpperCase();
  const status: ReportStatus = raw === 'COMPLETE' ? 'COMPLETE' : raw === 'PARTIAL' ? 'PARTIAL' : 'NO_DATA';
  const sections = report.sections;
  return {
    status,
    complete: status === 'COMPLETE',
    missing: missingChips(report.missing as string[]),
    sectionCount: sections && typeof sections === 'object' ? Object.keys(sections).length : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Provenance helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Turn a backend `sources` map into human-readable provenance chips. */
export function sourceChips(sources: Record<string, any> | null | undefined): { key: string; label: string; value: string }[] {
  if (!sources || typeof sources !== 'object') return [];
  return Object.entries(sources)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ({
      key: k,
      label: k.replace(/([A-Z])/g, ' $1').trim().toUpperCase(),
      value: String(v),
    }));
}

/**
 * Merge a REST snapshot with the ~1 Hz realtime frame. Realtime only ever
 * overwrites the fields it actually carries; everything else is left at the
 * REST value so a missing realtime field degrades to "stale" not "zero".
 */
export function mergeLive<T extends Record<string, any>>(
  rest: T | null | undefined,
  realtime: Record<string, any> | null | undefined,
): T | Record<string, any> {
  if (!rest) return rest ?? {};
  if (!realtime) return rest;
  const out: Record<string, any> = { ...rest, _realtimeAt: Date.now() };
  for (const [k, v] of Object.entries(realtime)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}
