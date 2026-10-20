'use client';

/**
 * System Indicators — visual primitives.
 *
 * Hand-rolled SVG/CSS for the observatory surface so the page carries its own
 * effect vocabulary (aurora field, rotating live rings, flowing meters) instead
 * of borrowing tiles, and so it stays dependency-free and theme-driven: every
 * colour resolves through the runtime `--success / --warning / --info /
 * --purple / --teal / --destructive` tokens, so the whole page re-tints with
 * the active theme.
 *
 * HONESTY RULE (carried from the previous implementation): a visual is only
 * ever drawn from a number the backend actually returned. A missing value
 * renders an explicit "n/a" — never a 0%, a full ring, an empty meter or a flat
 * line, all of which would read as a real measurement. Ratios that need two
 * numbers and only have one are not normalised against a guess either.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ */
/* Accent vocabulary                                                    */
/* ------------------------------------------------------------------ */

export type Accent = 'primary' | 'info' | 'purple' | 'teal' | 'success' | 'warning' | 'danger' | 'neutral';

export type SysState = 'ok' | 'bad' | 'warn' | 'unknown';

/** CSS custom-property reference for an accent — resolved against the theme. */
const ACCENT_VAR: Record<Accent, string> = {
  primary: 'var(--primary)',
  info: 'var(--info)',
  purple: 'var(--purple)',
  teal: 'var(--teal)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--destructive)',
  neutral: 'var(--muted-foreground)',
};

/** Solid colour for SVG fills/strokes, which cannot take a Tailwind class. */
export const accentHsl = (a: Accent) => `hsl(${ACCENT_VAR[a]})`;

export type AccentSkin = {
  text: string;
  chip: string;
  border: string;
  bar: string;
  glow: string;
  gradient: string;
};

const ACCENT_SKIN: Record<Accent, AccentSkin> = {
  primary: {
    text: 'text-primary',
    chip: 'bg-primary/12 text-primary ring-primary/25',
    border: 'border-primary/25',
    bar: 'bg-primary',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--primary)/0.7)]',
    gradient: 'from-primary/22 via-primary/6 to-transparent',
  },
  info: {
    text: 'text-info',
    chip: 'bg-info/12 text-info ring-info/25',
    border: 'border-info/25',
    bar: 'bg-info',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--info)/0.7)]',
    gradient: 'from-info/22 via-info/6 to-transparent',
  },
  purple: {
    text: 'text-purple',
    chip: 'bg-purple/12 text-purple ring-purple/25',
    border: 'border-purple/25',
    bar: 'bg-purple',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--purple)/0.7)]',
    gradient: 'from-purple/22 via-purple/6 to-transparent',
  },
  teal: {
    text: 'text-teal',
    chip: 'bg-teal/12 text-teal ring-teal/25',
    border: 'border-teal/25',
    bar: 'bg-teal',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--teal)/0.7)]',
    gradient: 'from-teal/22 via-teal/6 to-transparent',
  },
  success: {
    text: 'text-success',
    chip: 'bg-success/12 text-success ring-success/25',
    border: 'border-success/25',
    bar: 'bg-success',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--success)/0.7)]',
    gradient: 'from-success/22 via-success/6 to-transparent',
  },
  warning: {
    text: 'text-warning',
    chip: 'bg-warning/12 text-warning ring-warning/25',
    border: 'border-warning/25',
    bar: 'bg-warning',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--warning)/0.7)]',
    gradient: 'from-warning/22 via-warning/6 to-transparent',
  },
  danger: {
    text: 'text-destructive',
    chip: 'bg-destructive/12 text-destructive ring-destructive/25',
    border: 'border-destructive/25',
    bar: 'bg-destructive',
    glow: 'shadow-[0_0_24px_-8px_hsl(var(--destructive)/0.7)]',
    gradient: 'from-destructive/22 via-destructive/6 to-transparent',
  },
  neutral: {
    text: 'text-muted-foreground',
    chip: 'bg-muted text-muted-foreground ring-border',
    border: 'border-border',
    bar: 'bg-muted-foreground/60',
    glow: '',
    gradient: 'from-muted/60 to-transparent',
  },
};

export const skin = (a: Accent): AccentSkin => ACCENT_SKIN[a];

/** Health state → accent. The single mapping every indicator uses. */
export const STATE_ACCENT: Record<SysState, Accent> = {
  ok: 'success',
  bad: 'danger',
  warn: 'warning',
  unknown: 'neutral',
};

/**
 * Inline-style carrier for the staggered-entrance delay.
 *
 * `--ds-i` is a custom property, which `React.CSSProperties` does not model, so
 * every call site funnels through here instead of casting the object literal by
 * hand.
 */
export const stagger = (index: number): React.CSSProperties =>
  ({ '--ds-i': index } as React.CSSProperties);

/** Threshold ladder shared by every load/utilisation readout (85 / 60). */
export function loadAccent(pct: number | null | undefined): SysState {
  if (pct == null || !Number.isFinite(pct)) return 'unknown';
  if (pct >= 85) return 'bad';
  if (pct >= 60) return 'warn';
  return 'ok';
}

/**
 * Millisecond readout that stays readable at any magnitude.
 *
 * The backend reports latencies in ms with no ceiling of usefulness: an engine
 * that has not written since boot reports a "feed lag" in the hundreds of
 * millions of ms, which as a raw integer is an unreadable wall of digits. The
 * magnitude is preserved exactly, just expressed in the natural unit.
 */
export function fmtMsSmart(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) {
    const m = Math.floor(abs / 60_000);
    const s = Math.round((abs % 60_000) / 1000);
    return `${ms < 0 ? '-' : ''}${m}m ${s}s`;
  }
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  return `${ms < 0 ? '-' : ''}${d}d ${h}h`;
}

/* ------------------------------------------------------------------ */
/* Live halo dot — "this is connected, right now"                      */
/* ------------------------------------------------------------------ */

export function LiveHalo({
  accent,
  size = 9,
  label,
  live = true,
}: {
  accent: Accent;
  size?: number;
  label?: string;
  live?: boolean;
}) {
  const color = accentHsl(accent);
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={label}
    >
      {live && (
        <span
          aria-hidden
          className="si-halo absolute inset-0 rounded-full"
          style={{ background: color, opacity: 0.6 }}
        />
      )}
      <span
        aria-hidden
        className={cn('relative rounded-full', live ? 'ds-breathe' : '')}
        style={{
          width: size,
          height: size,
          background: live ? color : `hsl(var(--muted-foreground) / 0.45)`,
          boxShadow: live ? `0 0 10px ${color}` : undefined,
        }}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Animated number — counts up to the new value instead of snapping     */
/* ------------------------------------------------------------------ */

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Tween a number toward `value`. Monotonic-by-construction: the rAF loop reads
 * the latest `value` through a ref, so a burst of polling updates can never
 * leave two competing animations fighting over the same DOM text.
 */
export function AnimatedNumber({
  value,
  format,
  durationMs = 700,
  className,
}: {
  value: number | null | undefined;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const fromRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const target = value != null && Number.isFinite(value) ? value : null;

    if (target == null) {
      setShown(null);
      return;
    }

    const start = fromRef.current ?? shown ?? target;
    fromRef.current = target;

    if (start === target) {
      setShown(target);
      return;
    }

    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      setShown(start + (target - start) * easeOut(p));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // `shown` is intentionally excluded: it is the animation's own output, and
    // including it would restart the tween on every frame it produced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs]);

  return (
    <span className={className}>
      {shown == null ? <span className="text-muted-foreground">n/a</span> : format(shown)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Meter — gradient bar with a travelling highlight                      */
/* ------------------------------------------------------------------ */

export function Meter({
  pct,
  accent,
  height = 6,
  threshold,
  label,
  flow = true,
}: {
  /** 0-100, or null when the backend did not report a usable number. */
  pct: number | null | undefined;
  accent: Accent;
  height?: number;
  /** Optional 0-100 marker, e.g. the 85% "too hot" line. */
  threshold?: number | null;
  label?: string;
  /** Streamed highlight. Off for meters that only fill up monotonically. */
  flow?: boolean;
}) {
  const measurable = pct != null && Number.isFinite(pct);
  const width = measurable ? Math.min(100, Math.max(0, pct)) : 0;
  const color = accentHsl(accent);

  return (
    <div
      className="relative w-full overflow-hidden rounded-full bg-muted/70"
      style={{ height }}
      title={label ?? (measurable ? `${width.toFixed(1)}%` : 'No reading available')}
    >
      {measurable ? (
        <div
          key={width.toFixed(2)}
          className={cn('si-grow h-full rounded-full', flow && 'si-flow')}
          style={{
            width: `${width}%`,
            backgroundImage: `linear-gradient(90deg, ${color} 0%, ${color} 42%, hsl(var(--foreground) / 0.75) 50%, ${color} 58%, ${color} 100%)`,
            boxShadow: `0 0 12px -2px ${color}`,
          }}
        />
      ) : (
        /* Not a zero reading — an explicit absence, so it can't be misread. */
        <div className="h-full w-full rounded-full border border-dashed border-border bg-transparent" />
      )}

      {threshold != null && Number.isFinite(threshold) && (
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-foreground/25"
          style={{ left: `${Math.min(100, Math.max(0, threshold))}%` }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ring gauge — utilisation / fill ratios                               */
/* ------------------------------------------------------------------ */

/**
 * Donut gauge. With either number missing it renders the empty track plus an
 * explicit "n/a" instead of a misleading full or zero arc.
 */
export function Gauge({
  value,
  max = 100,
  accent = 'info',
  size = 108,
  thickness = 9,
  label,
  caption,
  live = false,
}: {
  value: number | null | undefined;
  /** Pass null to mark the ratio unmeasurable — the track plus "n/a" is drawn. */
  max?: number | null;
  accent?: Accent;
  size?: number;
  thickness?: number;
  label?: string;
  caption?: string;
  /** Adds the glow halo — only for values that are actively being sampled. */
  live?: boolean;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const measurable =
    value != null && Number.isFinite(value) && max != null && Number.isFinite(max) && max > 0;
  const pct = measurable ? Math.min(1, Math.max(0, value! / max!)) : 0;
  const dash = c * pct;
  const color = accentHsl(accent);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={thickness}
          opacity={0.5}
        />
        {measurable && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${Math.max(0, c - dash)}`}
            className="transition-[stroke-dasharray] duration-700 ease-out"
            style={live ? { filter: `drop-shadow(0 0 7px ${color}77)` } : undefined}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        {measurable ? (
          <span className="font-mono text-xl font-bold leading-none tabular-nums" style={{ color }}>
            {(pct * 100).toFixed(0)}%
          </span>
        ) : (
          <span className="font-mono text-xs font-semibold leading-none text-muted-foreground">n/a</span>
        )}
        {label ? (
          <span className="mt-1 max-w-[88%] text-[9px] font-semibold uppercase leading-tight tracking-wide text-muted-foreground">
            {label}
          </span>
        ) : null}
        {caption ? <span className="mt-0.5 text-[9px] text-muted-foreground/70">{caption}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Trend — gradient area sparkline of an already-measured series        */
/* ------------------------------------------------------------------ */

/**
 * Trend line. Fewer than three finite points renders a dashed baseline rather
 * than a filled wedge — with only two samples any gradient area normalises to a
 * full-height triangle, which reads as a dramatic spike that never happened.
 */
export function Trend({
  points,
  accent = 'info',
  width = 96,
  height = 30,
  gradientId,
}: {
  points: (number | null | undefined)[];
  accent?: Accent;
  width?: number;
  height?: number;
  /** Must be unique per instance — SVG gradient ids share one document scope. */
  gradientId: string;
}) {
  const usable = points.filter((p): p is number => p != null && Number.isFinite(p));
  const color = accentHsl(accent);

  if (usable.length < 3) {
    return (
      <svg width={width} height={height} aria-hidden className="shrink-0">
        <line
          x1={0}
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="hsl(var(--border))"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
      </svg>
    );
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min || 1;
  const step = width / (usable.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 5);
  const line = usable.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(p).toFixed(2)}`).join(' ');

  return (
    <svg width={width} height={height} aria-hidden className="shrink-0 overflow-visible">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.45} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={y(usable[usable.length - 1])} r={2.4} fill={color} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                               */
/* ------------------------------------------------------------------ */

/** Frosted panel with the hover sheen. `glow` lights it for live sections. */
export function Panel({
  children,
  className,
  sheen = true,
  lift = true,
  style,
}: {
  children: ReactNode;
  className?: string;
  sheen?: boolean;
  lift?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        'relative overflow-hidden rounded-2xl border border-border/60 bg-card/70 shadow-soft backdrop-blur-sm',
        lift && 'ds-lift',
        sheen && 'ds-card',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Section header with an accent chip, a count and an optional aside. */
export function SectionHead({
  icon: Icon,
  title,
  caption,
  accent = 'primary',
  count,
  aside,
}: {
  icon?: React.ElementType;
  title: string;
  caption?: string;
  accent?: Accent;
  count?: string;
  aside?: ReactNode;
}) {
  const s = skin(accent);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      {Icon ? (
        <span className={cn('flex h-8 w-8 items-center justify-center rounded-lg ring-1', s.chip)}>
          <Icon className="h-4 w-4" />
        </span>
      ) : null}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold tracking-tight">{title}</h2>
          {count ? (
            <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold ring-1', s.chip)}>
              {count}
            </span>
          ) : null}
        </div>
        {caption ? <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p> : null}
      </div>
      {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Readouts                                                             */
/* ------------------------------------------------------------------ */

/** Label/value row used inside detail grids. `NA` renders an explicit gap. */
export function Readout({
  label,
  value,
  accent,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  accent?: Accent;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-1.5 text-[11px] last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn('truncate text-right font-semibold', mono && 'font-mono tabular-nums', accent && skin(accent).text)}
      >
        {value ?? <span className="font-sans font-normal text-muted-foreground">n/a</span>}
      </span>
    </div>
  );
}

/** Coloured inline chip for a single engine/service metric. */
export function MetricChip({
  label,
  value,
  accent = 'neutral',
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  accent?: Accent;
  icon?: React.ElementType;
}) {
  const s = skin(accent);
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 ring-1', s.chip)}>
      {Icon ? <Icon className="h-3 w-3 shrink-0 self-start opacity-80" /> : null}
      {/* The label wraps to a second line rather than truncating: engine config
          keys are long ("Session Lifetime Seconds") and a chip that renders
          "Session Lifetime S…" hides the unit, which is the useful part. */}
      <span className="min-w-0 text-[10px] font-medium leading-[1.15] opacity-75">{label}</span>
      <span className="ml-auto shrink-0 self-center font-mono text-[11px] font-bold tabular-nums">{value}</span>
    </div>
  );
}

/** Status pill: coloured dot + label, used for state/health everywhere. */
export function Pill({
  label,
  accent = 'neutral',
  icon: Icon,
  live = false,
  className,
}: {
  label: string;
  accent?: Accent;
  icon?: React.ElementType;
  live?: boolean;
  className?: string;
}) {
  const s = skin(accent);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1',
        s.chip,
        className,
      )}
    >
      <LiveHalo accent={accent} size={6} live={live} />
      {Icon ? <Icon className="h-3 w-3 opacity-80" /> : null}
      {label}
    </span>
  );
}

/** Horizontal proportional bar for a set of labelled parts (queue splits etc). */
export function SplitBar({
  parts,
  height = 8,
}: {
  parts: { id: string; label: string; value: number; accent?: Accent }[];
  height?: number;
}) {
  const usable = parts.filter((p) => Number.isFinite(p.value) && p.value > 0);
  const total = usable.reduce((a, p) => a + p.value, 0);

  if (total <= 0) {
    return (
      <div
        className="w-full rounded-full border border-dashed border-border"
        style={{ height }}
        title="Nothing reported yet."
      />
    );
  }

  return (
    <div className="flex w-full gap-0.5 overflow-hidden rounded-full bg-muted/60" style={{ height }}>
      {usable.map((p) => {
        const color = accentHsl(p.accent ?? 'info');
        return (
          <div
            key={p.id}
            className="si-flow h-full transition-all duration-700 first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(p.value / total) * 100}%`,
              backgroundImage: `linear-gradient(90deg, ${color} 0%, ${color} 58%, hsl(var(--foreground) / 0.45) 50%, ${color} 100%)`,
              backgroundSize: '220% 100%',
            }}
            title={`${p.label}: ${p.value.toLocaleString('en-IN')}`}
          />
        );
      })}
    </div>
  );
}
