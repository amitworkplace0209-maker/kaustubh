'use client';

/**
 * Broker Terminal — visual primitives.
 *
 * Hand-rolled SVG/CSS so the broker surfaces stay in the first paint (no chart
 * library payload) and follow the app's runtime theme tokens.
 *
 * HONESTY RULE (carried from `broker-shared`): every visual here is derived
 * ONLY from a number the backend actually returned. A missing value renders an
 * explicit empty state — never a 0%, a full ring or an empty bar, which would
 * read as a real measurement. Where a ratio needs two numbers and only one
 * exists, the component renders "n/a" instead of normalising against a guess.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { terminalHue } from './broker-shared';

// ---------------------------------------------------------------------------
// Ring gauge — margin utilisation, connection health, fill ratio
// ---------------------------------------------------------------------------

export type RingTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const RING_STROKE: Record<RingTone, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  danger: 'hsl(var(--destructive))',
  info: 'hsl(var(--info))',
  neutral: 'hsl(var(--muted-foreground))',
};

/**
 * Donut gauge. `value`/`max` null-safe: with either missing it renders the
 * empty track plus an "n/a" caption rather than a misleading arc.
 */
export function RingGauge({
  value,
  max = 100,
  label,
  caption,
  tone = 'neutral',
  size = 116,
  thickness = 9,
  live = false,
  children,
}: {
  value: number | null | undefined;
  max?: number;
  label?: string;
  caption?: string;
  tone?: RingTone;
  size?: number;
  thickness?: number;
  live?: boolean;
  children?: ReactNode;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const measurable =
    value != null && Number.isFinite(value) && max != null && Number.isFinite(max) && max > 0;
  const pct = measurable ? Math.min(1, Math.max(0, value! / max!)) : 0;
  const dash = c * pct;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={thickness} opacity={0.55} />
        {measurable ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={RING_STROKE[tone]}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            className="transition-[stroke-dasharray] duration-700 ease-out"
            style={live ? { filter: `drop-shadow(0 0 6px ${RING_STROKE[tone]}66)` } : undefined}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {measurable ? (
          <span
            className="font-mono text-xl font-semibold leading-none tabular-nums"
            style={{ color: RING_STROKE[tone] }}
          >
            {(pct * 100).toFixed(0)}%
          </span>
        ) : (
          <span className="font-mono text-xs font-medium leading-none text-muted-foreground">n/a</span>
        )}
        {label ? (
          <span className="mt-1 max-w-[86%] text-[9px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
            {label}
          </span>
        ) : null}
        {caption ? <span className="mt-0.5 text-[9px] text-muted-foreground/70">{caption}</span> : null}
        {children}
      </div>
    </div>
  );
}

/** Margin-utilisation tone ladder — >100% over the line, >70% tight.
 *  Narrowed to the four tones `SectionCardHead` accepts for this card. */
export function marginTone(pct: number | null | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (pct == null || !Number.isFinite(pct)) return 'neutral';
  if (pct > 100) return 'danger';
  if (pct > 70) return 'warning';
  return 'success';
}

// ---------------------------------------------------------------------------
// Allocation bar — how capital splits across brokers
// ---------------------------------------------------------------------------

export interface AllocationSlice {
  id: string;
  label: string;
  value: number | null;
}

/**
 * Stacked proportion bar. Only terminals with a real number are plotted; a
 * total of zero renders the empty track rather than dividing by zero.
 */
export function AllocationBar({
  slices,
  total,
  height = 10,
}: {
  slices: AllocationSlice[];
  total: number | null;
  height?: number;
}) {
  const usable = slices.filter((s) => s.value != null && Number.isFinite(s.value!) && s.value! > 0);
  const sum = total ?? usable.reduce((a, s) => a + (s.value ?? 0), 0);

  if (!usable.length || sum <= 0) {
    return (
      <div
        className="w-full rounded-full border border-dashed border-border bg-muted/40"
        style={{ height }}
        title="No broker reported a balance to allocate."
      />
    );
  }

  return (
    <div
      className="flex w-full gap-0.5 overflow-hidden rounded-full bg-muted/60"
      style={{ height }}
    >
      {usable.map((s) => (
        <div
          key={s.id}
          className="h-full transition-all duration-700 first:rounded-l-full last:rounded-r-full"
          style={{
            width: `${((s.value ?? 0) / sum) * 100}%`,
            background: terminalHue(s.id),
          }}
          title={`${s.label}: ${(s.value ?? 0).toLocaleString('en-IN')}`}
        />
      ))}
    </div>
  );
}

/** Legend row that pairs with `AllocationBar`. */
export function AllocationLegend({
  slices,
  total,
}: {
  slices: AllocationSlice[];
  total: number | null;
}) {
  const usable = slices.filter((s) => s.value != null && s.value! > 0);
  const sum = total ?? usable.reduce((a, s) => a + (s.value ?? 0), 0);
  if (!usable.length || sum <= 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {usable.map((s) => (
        <li key={s.id} className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: terminalHue(s.id) }} />
          <span className="text-[10px] text-muted-foreground">{s.label}</span>
          <span className="font-mono text-[10px] tabular-nums">{((s.value ?? 0) / sum * 100).toFixed(1)}%</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Position bar — long vs short exposure
// ---------------------------------------------------------------------------

/** Long/short split. Renders the empty track when both are zero. */
export function PositionBar({ long, short }: { long: number | null; short: number | null }) {
  const l = long != null && Number.isFinite(long) ? Math.max(0, long) : null;
  const s = short != null && Number.isFinite(short) ? Math.max(0, short) : null;
  if ((l ?? 0) === 0 && (s ?? 0) === 0) {
    return (
      <div className="h-2 w-full rounded-full border border-dashed border-border bg-muted/40" title="No open position quantity reported." />
    );
  }
  const total = (l ?? 0) + (s ?? 0);
  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted/60">
      <div
        className="h-full rounded-l-full bg-success transition-all duration-700"
        style={{ width: `${((l ?? 0) / total) * 100}%` }}
        title={`Long: ${(l ?? 0).toLocaleString('en-IN')}`}
      />
      <div
        className="h-full rounded-r-full bg-destructive transition-all duration-700"
        style={{ width: `${((s ?? 0) / total) * 100}%` }}
        title={`Short: ${(s ?? 0).toLocaleString('en-IN')}`}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order lifecycle bar — open / pending / completed / cancelled / rejected
// ---------------------------------------------------------------------------

const ORDER_SEGMENT: { key: string; label: string; cls: string }[] = [
  { key: 'open', label: 'Open', cls: 'bg-info' },
  { key: 'pending', label: 'Pending', cls: 'bg-warning' },
  { key: 'partial', label: 'Partial', cls: 'bg-purple' },
  { key: 'completed', label: 'Complete', cls: 'bg-success' },
  { key: 'cancelled', label: 'Cancelled', cls: 'bg-muted-foreground/50' },
  { key: 'rejected', label: 'Rejected', cls: 'bg-destructive' },
];

export function OrderLifecycleBar({ orders }: { orders: Record<string, any> | null | undefined }) {
  const entries = ORDER_SEGMENT.map((s) => ({
    ...s,
    n: Number(orders?.[s.key] ?? 0) || 0,
  })).filter((s) => s.n > 0);
  const total = entries.reduce((a, s) => a + s.n, 0);

  if (!entries.length || total === 0) {
    return (
      <div className="h-2 w-full rounded-full border border-dashed border-border bg-muted/40" title="No orders reported by the engine." />
    );
  }

  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted/60">
      {entries.map((s, i) => (
        <div
          key={s.key}
          className={cn('h-full transition-all duration-700', s.cls, i === 0 && 'rounded-l-full', i === entries.length - 1 && 'rounded-r-full')}
          style={{ width: `${(s.n / total) * 100}%` }}
          title={`${s.label}: ${s.n}`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — trend of an already-measured series
// ---------------------------------------------------------------------------

/** Inline trend. Fewer than two points renders a dashed baseline, not a fake rise. */
export function Sparkline({
  points,
  tone = 'info',
  width = 72,
  height = 24,
}: {
  points: number[];
  tone?: RingTone;
  width?: number;
  height?: number;
}) {
  const color = RING_STROKE[tone];
  const usable = points.filter((p) => typeof p === 'number' && Number.isFinite(p));

  if (usable.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden>
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="hsl(var(--border))" strokeWidth={1.5} strokeDasharray="3 3" />
      </svg>
    );
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min || 1;
  const step = width / (usable.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 5);
  const d = usable.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(p).toFixed(2)}`).join(' ');

  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <defs>
        <linearGradient id={`cm-bk-${tone}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.38} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#cm-bk-${tone})`} />
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={y(usable[usable.length - 1])} r={2.25} fill={color} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Hero shell — shared by the overview and profile pages
// ---------------------------------------------------------------------------

export interface HeroAccent {
  border: string;
  wash: string;
  bar: string;
  chip: string;
  text: string;
}

const HERO_ACCENT: Record<RingTone, HeroAccent> = {
  success: { border: 'border-success/30', wash: 'from-success/[0.14] via-success/[0.04] to-transparent', bar: 'bg-success', chip: 'bg-success/15 ring-success/30', text: 'text-success' },
  warning: { border: 'border-warning/35', wash: 'from-warning/[0.14] via-warning/[0.04] to-transparent', bar: 'bg-warning', chip: 'bg-warning/15 ring-warning/30', text: 'text-warning' },
  danger: { border: 'border-destructive/35', wash: 'from-destructive/[0.14] via-destructive/[0.04] to-transparent', bar: 'bg-destructive', chip: 'bg-destructive/15 ring-destructive/30', text: 'text-destructive' },
  info: { border: 'border-info/30', wash: 'from-info/[0.13] via-info/[0.04] to-transparent', bar: 'bg-info', chip: 'bg-info/15 ring-info/30', text: 'text-info' },
  neutral: { border: 'border-border', wash: 'from-muted/60 to-transparent', bar: 'bg-border', chip: 'bg-muted/70 ring-border/50', text: 'text-muted-foreground' },
};

export function heroAccent(tone: RingTone): HeroAccent {
  return HERO_ACCENT[tone];
}

/** The full-bleed hero shell with the conic sweep + top bar. */
export function BrokerHero({
  accent,
  children,
  className,
}: {
  accent: HeroAccent;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('cm-sweep relative overflow-hidden rounded-2xl shadow-soft-lg', accent.border, accent.wash, className)}>
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px]', accent.bar)} />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="relative p-5">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat tile — hero counter
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  tone = 'text-foreground',
  sub,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  sub?: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex min-w-[70px] flex-col items-center rounded-xl border border-border/50 bg-background/40 px-2.5 py-1.5 backdrop-blur">
      <span className={`font-mono text-lg font-semibold leading-none tabular-nums ${tone}`}>{value}</span>
      <span className="mt-1 flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">
        {Icon ? <Icon className="h-2.5 w-2.5" aria-hidden /> : null}
        {label}
      </span>
      {sub ? <span className="mt-0.5 text-[9px] text-muted-foreground/70">{sub}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection pulse — live indicator dot
// ---------------------------------------------------------------------------

export function LiveDot({ live, size = 8 }: { live: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-full', live ? 'animate-pulse bg-success' : 'bg-muted-foreground/50')}
      style={{ width: size, height: size }}
    />
  );
}