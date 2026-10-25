'use client';

/**
 * Small presentation pieces shared by the VM overview and VM detail pages.
 *
 * Everything here is a read-only rendering of a real value. When a value is
 * missing the component says so; it never substitutes zero or a placeholder
 * that could be mistaken for a measurement.
 */

import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AccentTone } from '@/components/design-system';
import { fmtMetric, type VmTone } from '@/lib/vm-management';

export const TONE_TEXT: Record<VmTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
  neutral: 'text-muted-foreground',
};

export const TONE_BG: Record<VmTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
  neutral: 'bg-muted-foreground/40',
};

/** `StatCard` speaks AccentTone; map the one tone name that differs. */
export function statAccent(tone: VmTone): AccentTone {
  return tone === 'info' ? 'blue' : tone;
}

/** One labelled reading. `value` is already formatted; null renders `n/a`. */
export function VmMetric({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'neutral',
  title,
}: {
  icon?: React.ElementType;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: VmTone;
  title?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2" title={title}>
      <div className="flex items-center gap-1.5">
        {Icon ? <Icon className={cn('h-3 w-3 shrink-0', TONE_TEXT[tone])} /> : null}
        <p className="truncate text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className={cn('mt-0.5 truncate font-mono text-sm font-bold leading-5 tabular-nums', TONE_TEXT[tone])}>
        {value}
      </p>
      {sub ? <p className="truncate text-[9px] text-muted-foreground/80">{sub}</p> : null}
    </div>
  );
}

/** Numeric reading with the honest `n/a` fallback built in. */
export function VmNumber({
  icon,
  label,
  value,
  digits = 1,
  suffix = '',
  sub,
  tone = 'neutral',
}: {
  icon?: React.ElementType;
  label: string;
  value: number | null | undefined;
  digits?: number;
  suffix?: string;
  sub?: ReactNode;
  tone?: VmTone;
}) {
  const missing = value == null || !Number.isFinite(value);
  return (
    <VmMetric
      icon={icon}
      label={label}
      value={missing ? 'n/a' : fmtMetric(value, digits, suffix)}
      sub={missing ? 'not reported' : sub}
      tone={missing ? 'neutral' : tone}
    />
  );
}

/**
 * Sparkline over real samples. Missing samples break the line instead of being
 * interpolated across, so a hole in telemetry is visible as a hole.
 */
export function Sparkline({
  values,
  tone = 'info',
  height = 40,
  label,
  format = (v) => `${v.toFixed(1)}%`,
}: {
  values: Array<number | null>;
  tone?: VmTone;
  height?: number;
  label: string;
  format?: (value: number) => string;
}) {
  const real = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (real.length < 2) {
    return (
      <p className="py-3 text-center text-[10px] text-muted-foreground">
        Not enough samples to draw a trend.
      </p>
    );
  }

  const width = 200;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number) => 34 - ((v - min) / span) * 28 - 2;

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  const last = real[real.length - 1];
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} 36`}
        height={height}
        width="100%"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: current ${format(last)}, minimum ${format(min)}, maximum ${format(max)}`}
        className={TONE_TEXT[tone]}
      >
        <title>{label}</title>
        {segments.map((points, i) => (
          <polyline
            key={i}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="mt-0.5 flex items-center justify-between text-[9px] tabular-nums text-muted-foreground">
        <span>min {format(min)}</span>
        <span className="font-semibold text-foreground">now {format(last)}</span>
        <span>max {format(max)}</span>
      </div>
    </div>
  );
}

/** Explicit placeholder for a whole panel that has nothing real to show. */
export function NoTelemetry({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <HelpCircle className="mb-2 h-6 w-6 text-muted-foreground/40" />
      <p className="max-w-sm text-xs text-muted-foreground">{text}</p>
    </div>
  );
}
