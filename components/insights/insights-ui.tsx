'use client';

// Shared design system for EVERY Data Saver Insights route (overview,
// attention, activity, errors, today, reports/*).
//
// HONESTY CONTRACT (unchanged from lib/insights.ts):
// A metric the backend reports as null renders as an em dash — never 0, never
// an invented number. Nothing here computes a health score or a trend of its
// own; every value is passed in already measured.
//
// LAYOUT CONTRACT:
//   Tile   — collapsed: hero value + key rows. Expanded: detail rows + note +
//            an optional custom block. Keeps pages short without hiding data.
//   Grid   — responsive column counts (2 / 3 / 4 / 5).
//   Table  — compact, sticky header, bounded height, DATA-DRIVEN columns.

import { useMemo, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SectionCard, SectionHeading, StatusBadge, EmptyState, ErrorState, LoadingState,
  LiveIndicator,
} from '@/components/design-system';

/* ========================================================================== */
/* Tones                                                                       */
/* ========================================================================== */

export type UiTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const ACCENT: Record<string, string> = {
  success: 'from-emerald-500 to-teal-500',
  teal: 'from-teal-500 to-emerald-500',
  sky: 'from-sky-500 to-blue-500',
  blue: 'from-blue-500 to-indigo-500',
  violet: 'from-violet-500 to-purple-500',
  purple: 'from-fuchsia-500 to-pink-500',
  amber: 'from-amber-500 to-orange-500',
  orange: 'from-orange-500 to-rose-500',
  rose: 'from-rose-500 to-pink-500',
  danger: 'from-rose-500 to-orange-500',
  slate: 'from-slate-500 to-slate-400',
};

const TONE_TEXT: Record<UiTone, string> = {
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  danger: 'text-destructive',
  info: 'text-sky-500',
  neutral: 'text-muted-foreground',
};

export type RowTone = UiTone;

const ROW_TEXT: Record<RowTone, string> = {
  success: 'text-emerald-500',
  warning: 'text-amber-500',
  danger: 'text-destructive',
  info: 'text-sky-500',
  neutral: 'text-foreground',
};

export function accentFor(tone: string): string {
  return ACCENT[tone] ?? ACCENT.slate;
}

export function toneText(tone: UiTone): string {
  return TONE_TEXT[tone];
}

/** Severity / percentage -> a tone, without inventing a threshold that isn't documented. */
export function pctTone(v: number | null | undefined, good = 95, ok = 80): UiTone {
  if (v == null || !Number.isFinite(v)) return 'neutral';
  if (v >= good) return 'success';
  if (v >= ok) return 'warning';
  return 'danger';
}

/** Health score uses the documented 90 / 80 bands. */
export function healthTone(v: number | null | undefined): UiTone {
  if (v == null || !Number.isFinite(v)) return 'neutral';
  if (v >= 90) return 'success';
  if (v >= 80) return 'warning';
  return 'danger';
}

export function countTone(v: number | null | undefined, warnAt = 1, badAt = 1): UiTone {
  if (v == null || !Number.isFinite(v)) return 'neutral';
  if (v >= badAt) return 'danger';
  if (v >= warnAt) return 'warning';
  return 'success';
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

/** The one honest formatter: null / non-finite -> em dash. */
export function val(v: unknown, suffix = ''): string {
  if (v == null) return '—';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '—';
    return `${v.toLocaleString('en-IN', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 })}${suffix}`;
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const s = String(v);
  return s === '' ? '—' : s;
}

/** camelCase / snake_case / kebab-case -> human label. */
export function labelize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

const MS_KEYS = ['ms', 'millis', 'duration', 'latency', 'elapsed', 'uptime', 'age'];
const PCT_KEYS = ['pct', 'percent', 'rate', 'success', 'accuracy', 'completeness', 'freshness', 'score', 'grade'];

export function suffixFor(key: string, v: unknown): string {
  if (typeof v !== 'number') return '';
  const k = key.toLowerCase();
  if (MS_KEYS.some((s) => k.includes(s))) return ' ms';
  if (PCT_KEYS.some((s) => k.includes(s))) return '%';
  if (k.includes('sec')) return ' s';
  return '';
}

/* ========================================================================== */
/* Page header                                                                 */
/* ========================================================================== */

export function InsightHeader({
  title, subtitle, live, actions, badges, tone,
}: {
  title: string;
  subtitle?: React.ReactNode;
  live?: boolean;
  actions?: React.ReactNode;
  badges?: React.ReactNode;
  tone?: string;
}) {
  return (
    <header className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/60 px-4 py-3">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r', accentFor(tone ?? 'slate'))} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-sm font-bold leading-tight">{title}</h1>
            {live != null && <LiveIndicator live={live} label={live ? 'Live' : 'Connecting'} />}
          </div>
          {subtitle && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {badges && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-2">{badges}</div>
      )}
    </header>
  );
}

export function RefreshButton({ onClick, busy, label = 'Refresh' }: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md border border-border/60 p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
    </button>
  );
}

export function ChipButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors',
        active
          ? 'border-teal-500/50 bg-teal-500/10 text-teal-500'
          : 'border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/* ========================================================================== */
/* Tile                                                                        */
/* ========================================================================== */

export interface TileRow {
  label: string;
  value: string;
  tone?: RowTone;
  hint?: string;
}

export interface TileProps {
  icon?: React.ElementType;
  title: string;
  accent?: string;
  hero: string;
  heroUnit?: string;
  heroLabel: string;
  heroTone?: UiTone;
  note?: string;
  keyRows?: TileRow[];
  detailRows?: TileRow[];
  detail?: React.ReactNode;
  detailTitle?: string;
  defaultOpen?: boolean;
  footer?: React.ReactNode;
}

export function Tile(props: TileProps) {
  const [open, setOpen] = useState(!!props.defaultOpen);
  const Icon = props.icon;
  const heroEmpty = props.hero === '—';
  const hasDetail = (props.detailRows?.length ?? 0) > 0 || !!props.detail || !!props.note;

  return (
    <article className="relative flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/60">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r', accentFor(props.accent ?? 'slate'))} />

      <header className="flex items-center gap-1.5 px-3 pt-2.5">
        {Icon && (
          <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm', accentFor(props.accent ?? 'slate'))}>
            <Icon className="h-3 w-3" />
          </span>
        )}
        <h3 className="min-w-0 flex-1 truncate text-[10px] font-bold uppercase tracking-wider">{props.title}</h3>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? 'Hide details' : 'Show details'}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </header>

      <div className="px-3 pt-1.5">
        <p className="flex items-baseline gap-1">
          <span className={cn('text-xl font-bold leading-none tabular-nums', heroEmpty ? 'text-muted-foreground' : toneText(props.heroTone ?? 'neutral'))}>
            {props.hero}
          </span>
          {props.heroUnit && <span className="text-[10px] text-muted-foreground">{props.heroUnit}</span>}
        </p>
        <p className="text-[8px] uppercase tracking-wider text-muted-foreground">{props.heroLabel}</p>
      </div>

      {(props.keyRows?.length ?? 0) > 0 && (
        <dl className="space-y-0.5 px-3 pb-2 pt-1.5">
          {props.keyRows!.map((r) => <TileKey key={r.label} row={r} />)}
          {open && props.detailRows!.map((r) => <TileKey key={r.label} row={r} />)}
        </dl>
      )}
      {!props.keyRows?.length && open && (props.detailRows?.length ?? 0) > 0 && (
        <dl className="space-y-0.5 px-3 pb-2 pt-1.5">
          {props.detailRows!.map((r) => <TileKey key={r.label} row={r} />)}
        </dl>
      )}

      {open && props.note && (
        <p className="mx-3 mb-1.5 truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground/80" title={props.note}>
          {props.note}
        </p>
      )}

      {open && props.detail && (
        <div className="border-t border-border/50 px-3 py-2">
          {props.detailTitle && (
            <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{props.detailTitle}</p>
          )}
          {props.detail}
        </div>
      )}

      {props.footer && <div className="mt-auto border-t border-border/40 px-3 py-1.5">{props.footer}</div>}
    </article>
  );
}

function TileKey({ row }: { row: TileRow }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[10px] leading-tight">
      <dt className="truncate text-muted-foreground" title={row.label}>{row.label}</dt>
      <dd
        className={cn('shrink-0 truncate font-mono font-medium tabular-nums', ROW_TEXT[row.tone ?? 'neutral'])}
        title={row.hint ?? row.value}
      >
        {row.value}
      </dd>
    </div>
  );
}

export function TileGrid({ children, cols = 4 }: { children: React.ReactNode; cols?: 2 | 3 | 4 | 5 }) {
  const map = {
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-2 lg:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
    5: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
  } as const;
  return <section className={cn('grid grid-cols-1 gap-2.5', map[cols])}>{children}</section>;
}

/* ========================================================================== */
/* Compact table — data-driven columns, sticky header, bounded height         */
/* ========================================================================== */

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** Dropped from the phone layout so a row stays readable. */
  compactHide?: boolean;
  /** Never rendered — returned when no loaded row has a value for it. */
  render: (row: T, index: number) => React.ReactNode;
}

export function DataTable<T>({
  columns, rows, rowId, maxHeight = 300, onRowClick, selectedId, empty, verify, footer,
}: {
  columns: Column<T>[];
  rows: T[];
  rowId: (row: T, i: number) => string;
  maxHeight?: number;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  empty?: React.ReactNode;
  verify?: string;
  footer?: React.ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  if (rows.length === 0) return null;

  return (
    <div data-verify={verify}>
      <div className="overflow-auto rounded-lg border border-border/50" style={{ maxHeight }}>
        <table className="w-full text-[10px] leading-tight tabular-nums">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border/60 text-left text-[9px] uppercase tracking-wider text-muted-foreground">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn('whitespace-nowrap py-1 pl-2 pr-2 font-semibold', c.align === 'right' && 'text-right', c.compactHide && 'hidden sm:table-cell')}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const id = rowId(r, i);
              return (
                <tr
                  key={id}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={cn(
                    'border-b border-border/25 transition-colors last:border-0',
                    onRowClick && 'cursor-pointer hover:bg-muted/40',
                    selectedId === id && 'bg-primary/10',
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-2 py-1 align-middle',
                        c.align === 'right' && 'text-right font-mono',
                        c.compactHide && 'hidden sm:table-cell',
                      )}
                    >
                      {c.render(r, i)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] font-mono text-muted-foreground">{footer}</div>}
    </div>
  );
}

/** Column set filtered to those at least one loaded row actually populates. */
export function useVisibleColumns<T>(all: Column<T>[], rows: T[], has: (c: Column<T>, r: T) => boolean): Column<T>[] {
  return useMemo(() => all.filter((c) => rows.some((r) => has(c, r))), [all, rows, has]);
}

/* ========================================================================== */
/* Key/value blocks                                                            */
/* ========================================================================== */

export interface KV {
  key: string;
  value: string;
  tone?: RowTone;
  hint?: string;
}

/** Real scalars from a backend object, minus nulls / empty collections. */
export function pickScalars(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v == null || v === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function scalarsToKV(obj: unknown, prefix?: string): KV[] {
  const picked = pickScalars(obj);
  if (!picked) return [];
  return Object.entries(picked).map(([k, v]) => ({
    key: prefix ? `${prefix} ${labelize(k)}` : labelize(k),
    value: typeof v === 'number' || typeof v === 'boolean' ? val(v, suffixFor(k, v)) : String(v),
  }));
}

export function KVBlock({ title, items, cols = 4, verify }: {
  title?: string; items: KV[]; cols?: 2 | 3 | 4; verify?: string;
}) {
  if (items.length === 0) return null;
  const map = { 2: 'grid-cols-2', 3: 'grid-cols-2 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' } as const;
  return (
    <div data-verify={verify}>
      {title && <SectionHeading>{title}</SectionHeading>}
      <dl className={cn('mt-1.5 grid gap-1.5', map[cols])}>
        {items.map((kv) => (
          <div key={kv.key} className="rounded-lg border border-border/50 bg-card/50 px-2 py-1.5">
            <dt className="truncate text-[9px] uppercase tracking-wide text-muted-foreground" title={kv.key}>{kv.key}</dt>
            <dd className={cn('truncate text-xs font-semibold tabular-nums', kv.tone ? ROW_TEXT[kv.tone] : 'text-foreground')} title={kv.hint ?? kv.value}>
              {kv.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ========================================================================== */
/* Charts (tiny, dependency-free)                                             */
/* ========================================================================== */

const SPARK_PALETTE = ['#14b8a6', '#38bdf8', '#8b5cf6', '#f59e0b', '#f43f5e', '#10b981'];

export function SparkBars({ data, color = '#14b8a6', palette, height = 32 }: {
  data: (number | null)[]; color?: string; palette?: boolean; height?: number;
}) {
  const gid = useMemo(() => `sb-${Math.random().toString(36).slice(2, 8)}`, []);
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d ?? 0), 1);
  const step = Math.max(1, Math.floor(400 / data.length));

  return (
    <svg viewBox={`0 0 ${data.length * step} 100`} preserveAspectRatio="none" style={{ height }} className="w-full" aria-hidden>
      {!palette && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={1} />
            <stop offset="100%" stopColor={color} stopOpacity={0.3} />
          </linearGradient>
        </defs>
      )}
      {data.map((d, i) => {
        const h = d != null ? (d / max) * 100 : 0;
        return (
          <rect
            key={i} x={i * step} y={100 - h} width={Math.max(step - 0.6, 1)}
            height={Math.max(h, d != null && d > 0 ? 2 : 0)}
            fill={palette ? SPARK_PALETTE[i % SPARK_PALETTE.length] : `url(#${gid})`}
            rx={0.8} opacity={0.9}
          />
        );
      })}
    </svg>
  );
}

/* ========================================================================== */
/* States + misc                                                               */
/* ========================================================================== */

export function PageError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <InsightHeader title={title} />
      <ErrorState message={message} onRetry={onRetry} />
    </div>
  );
}

export function PageLoading({ title, subtitle, text }: { title: string; subtitle?: string; text: string }) {
  return (
    <div className="space-y-3">
      <InsightHeader title={title} subtitle={subtitle} />
      <LoadingState text={text} />
    </div>
  );
}

export function NoData({ icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return <EmptyState icon={icon} title={title} description={description} />;
}

export function StatusStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5">
      {children}
    </div>
  );
}

export function MiniBadge({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: UiTone }) {
  return (
    <span className="flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[9px]">
      <span className="uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn('font-mono font-semibold tabular-nums', toneText(tone))}>{value}</span>
    </span>
  );
}

export { SectionCard, SectionHeading, StatusBadge, EmptyState, ErrorState, LoadingState };

// The IST-aware formatters are part of the honesty contract, so every Insights
// page imports them from this one module alongside the primitives.
export {
  fmtCount, fmtCompact, fmtPercent, fmtMs, fmtTime, fmtDateTime, fmtAgo,
  severityState, SEVERITY_STATES, istDateNow,
} from '@/lib/insights';