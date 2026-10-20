'use client';

// Shared dashboard design system.
//
// Single source of truth for the metric-card language used across the app
// (dashboard, positions, ...): tone kit, value-state rules and the MetricCard
// itself. Pages must reuse these instead of re-implementing card styling so
// every page reads as the same trading terminal.

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export type AccentTone =
  | 'success' | 'warning' | 'danger' | 'orange' | 'teal'
  | 'cyan' | 'blue' | 'purple' | 'violet' | 'neutral';

/** Reusable value-state rule (presentation only).
 * The REAL numeric value decides the visual state of every financial card:
 * positive -> green, negative -> red, zero -> neutral white, unavailable -> muted. */
export type MetricValueState = 'positive' | 'negative' | 'zero' | 'unavailable';

export function getMetricState(v: number | null | undefined): MetricValueState {
  if (v == null || !Number.isFinite(v)) return 'unavailable';
  if (v > 0) return 'positive';
  if (v < 0) return 'negative';
  return 'zero';
}

/** Signed financial values (P&L family): state fully owns the card color. */
export function pnlTone(v: number | null | undefined): AccentTone {
  switch (getMetricState(v)) {
    case 'positive': return 'success';
    case 'negative': return 'danger';
    default: return 'neutral'; // zero or unavailable stays quiet, never green/red
  }
}

/** Unsigned magnitudes keep their category identity; anomalies/zeros fall back to state. */
export function stateTone(v: number | null | undefined, category: AccentTone): AccentTone {
  const s = getMetricState(v);
  if (s === 'negative') return 'danger'; // negative margin/exposure/value is anomalous
  if (s !== 'positive') return 'neutral'; // zero or unavailable -> neutral, not colored
  return category;
}

/**
 * Presentation-only tone kit per resolved accent:
 * bar/top line - resting border tint - faint gradient wash - icon chip -
 * baked soft shadow + soft state glow (rest & hover). Static literals only (JIT-safe).
 */
export const CARD_TONE: Record<AccentTone, {
  bar: string; border: string; tint: string; icon: string;
  hoverBorder: string; restShadow: string; hoverShadow: string;
}> = {
  success: {
    bar: 'bg-success',
    border: 'border-success/30',
    tint: 'from-success/[0.07]',
    icon: 'bg-success/15 text-success ring-success/30 group-hover:bg-success/25',
    hoverBorder: 'hover:border-success/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_hsl(var(--success)/0.4)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_hsl(var(--success)/0.55)]',
  },
  warning: {
    bar: 'bg-warning',
    border: 'border-warning/40',
    tint: 'from-warning/[0.06]',
    icon: 'bg-warning/15 text-warning ring-warning/30 group-hover:bg-warning/25',
    hoverBorder: 'hover:border-warning/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_hsl(var(--warning)/0.35)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_hsl(var(--warning)/0.5)]',
  },
  danger: {
    bar: 'bg-destructive',
    border: 'border-destructive/30',
    tint: 'from-destructive/[0.07]',
    icon: 'bg-destructive/15 text-destructive ring-destructive/30 group-hover:bg-destructive/25',
    hoverBorder: 'hover:border-destructive/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_hsl(var(--destructive)/0.4)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_hsl(var(--destructive)/0.55)]',
  },
  orange: {
    bar: 'bg-orange-500 dark:bg-orange-400',
    border: 'border-orange-500/30',
    tint: 'from-orange-500/[0.06]',
    icon: 'bg-orange-500/10 text-orange-600 ring-orange-500/25 dark:text-orange-400 group-hover:bg-orange-500/20',
    hoverBorder: 'hover:border-orange-500/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_rgba(249,115,22,0.3)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_rgba(249,115,22,0.45)]',
  },
  teal: {
    bar: 'bg-teal',
    border: 'border-teal/30',
    tint: 'from-teal/[0.06]',
    icon: 'bg-teal/10 text-teal ring-teal/25 group-hover:bg-teal/20',
    hoverBorder: 'hover:border-teal/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_hsl(var(--teal)/0.35)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_hsl(var(--teal)/0.5)]',
  },
  cyan: {
    bar: 'bg-cyan-500 dark:bg-cyan-400',
    border: 'border-cyan-500/30',
    tint: 'from-cyan-500/[0.06]',
    icon: 'bg-cyan-500/10 text-cyan-600 ring-cyan-500/25 dark:text-cyan-400 group-hover:bg-cyan-500/20',
    hoverBorder: 'hover:border-cyan-500/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_rgba(34,211,238,0.3)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_rgba(34,211,238,0.45)]',
  },
  blue: {
    bar: 'bg-blue-500 dark:bg-blue-400',
    border: 'border-blue-500/30',
    tint: 'from-blue-500/[0.06]',
    icon: 'bg-blue-500/10 text-blue-600 ring-blue-500/25 dark:text-blue-400 group-hover:bg-blue-500/20',
    hoverBorder: 'hover:border-blue-500/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_rgba(96,165,250,0.3)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_rgba(96,165,250,0.45)]',
  },
  purple: {
    bar: 'bg-purple',
    border: 'border-purple/30',
    tint: 'from-purple/[0.06]',
    icon: 'bg-purple/10 text-purple ring-purple/25 group-hover:bg-purple/20',
    hoverBorder: 'hover:border-purple/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_hsl(var(--purple)/0.35)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_hsl(var(--purple)/0.5)]',
  },
  violet: {
    bar: 'bg-violet-500 dark:bg-violet-400',
    border: 'border-violet-500/30',
    tint: 'from-violet-500/[0.06]',
    icon: 'bg-violet-500/10 text-violet-600 ring-violet-500/25 dark:text-violet-400 group-hover:bg-violet-500/20',
    hoverBorder: 'hover:border-violet-500/50',
    restShadow: 'shadow-[0_2px_8px_-2px_hsl(var(--foreground)/0.08),0_4px_16px_-4px_hsl(var(--foreground)/0.06),0_0_22px_-10px_rgba(139,92,246,0.3)]',
    hoverShadow: 'shadow-[0_4px_16px_-4px_hsl(var(--foreground)/0.12),0_8px_32px_-8px_hsl(var(--foreground)/0.08),0_0_28px_-8px_rgba(139,92,246,0.45)]',
  },
  neutral: {
    bar: 'bg-border',
    border: '',
    tint: 'from-foreground/[0.02]',
    icon: 'bg-muted/70 text-muted-foreground ring-border/50 group-hover:bg-muted',
    hoverBorder: 'hover:border-border',
    restShadow: 'shadow-soft',
    hoverShadow: 'hover:shadow-soft-lg',
  },
};

export type MetricCardProps = {
  icon: React.ElementType;
  tone?: AccentTone;
  title: string;
  value: string | null;
  sub?: React.ReactNode;
  valueClass?: string;
  loading?: boolean;
  stale?: boolean;
  unavailable?: boolean;
  dataVerify?: string;
  action?: React.ReactNode;
};

export function MetricCard({
  icon: Icon, tone = 'neutral', title, value, sub, valueClass,
  loading, stale, unavailable, dataVerify, action,
}: MetricCardProps) {
  const failed = Boolean(unavailable);
  const t = CARD_TONE[tone];
  return (
    <Card
      data-verify={dataVerify}
      className={`group relative h-full overflow-hidden transition-all duration-200 hover:-translate-y-0.5 ${t.border} ${t.restShadow} ${t.hoverBorder} ${t.hoverShadow}`}
    >
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${t.bar}`} />
      <span aria-hidden className={`pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent ${t.tint}`} />
      <CardContent className="relative flex h-full flex-col justify-between gap-1.5 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset transition-colors duration-200 ${t.icon}`}>
            <Icon className="h-4 w-4" />
          </span>
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{title}</p>
          {action}
          {stale && !loading && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
              title={'Showing last known value \u2014 current feed unavailable'}
            />
          )}
        </div>
        <div className="mt-0.5 min-h-[32px]">
          {loading ? (
            <Skeleton className="h-7 w-28" />
          ) : failed ? (
            <p className="truncate text-sm font-medium leading-8 text-muted-foreground">Data unavailable</p>
          ) : (
            <p
              title={typeof value === 'string' ? value : undefined}
              className={`truncate text-xl font-semibold leading-8 tracking-tight tabular-nums ${
                value != null ? valueClass ?? '' : 'font-medium text-muted-foreground'
              }`}
            >
              {value ?? 'N/A'}
            </p>
          )}
        </div>
        {!loading ? (
          <p className="truncate text-[11px] font-normal leading-4 text-muted-foreground tabular-nums">
            {failed ? 'Feed error \u00B7 retrying' : sub ?? '\u00A0'}
          </p>
        ) : (
          <p className="truncate text-[11px] font-normal leading-4 tabular-nums">&nbsp;</p>
        )}
      </CardContent>
    </Card>
  );
}

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
      <span aria-hidden className="h-px w-4 shrink-0 bg-gradient-to-r from-primary/40 to-transparent" />
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Shared UI Primitives — consistent across all pages
// ---------------------------------------------------------------------------

import { AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Page header with title, subtitle, and optional right-side action */
export function PageHeader({
  title, subtitle, children, className,
}: {
  title: string; subtitle?: React.ReactNode; children?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Compact section card with optional header */
export function SectionCard({
  title, icon: Icon, children, className, headerRight,
}: {
  title?: string; icon?: React.ElementType; children: React.ReactNode;
  className?: string; headerRight?: React.ReactNode;
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-card overflow-hidden', className)}>
      {(title || headerRight) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 border-b border-border/50">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
            {title && <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>}
          </div>
          {headerRight}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

/** Status badge with colored dot */
export function StatusBadge({
  status, label, className,
}: {
  status: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  label: string; className?: string;
}) {
  const colors = {
    success: 'border-success/30 bg-success/10 text-success',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    danger: 'border-destructive/30 bg-destructive/10 text-destructive',
    info: 'border-info/30 bg-info/10 text-info',
    neutral: 'border-border bg-muted text-muted-foreground',
  };
  const dotColors = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
    info: 'bg-info',
    neutral: 'bg-muted-foreground/50',
  };
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums',
      colors[status], className,
    )}>
      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotColors[status])} />
      {label}
    </span>
  );
}

/** Empty state with icon and message */
export function EmptyState({
  icon: Icon, title, description, action, className,
}: {
  icon: React.ElementType; title: string; description?: string;
  action?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50 mb-3">
        <Icon className="h-6 w-6 text-muted-foreground/50" />
      </div>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && <p className="text-xs text-muted-foreground/60 mt-1 max-w-[280px]">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Loading state with spinner */
export function LoadingState({ text = 'Loading...', className }: { text?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center py-12', className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {text}
      </div>
    </div>
  );
}

/** Error state with retry */
export function ErrorState({
  message, onRetry, className,
}: {
  message: string; onRetry?: () => void; className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 text-center', className)}>
      <AlertCircle className="h-8 w-8 text-destructive/50 mb-3" />
      <p className="text-sm font-medium text-destructive">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-3 gap-1.5" onClick={onRetry}>
          <RefreshCw className="h-3 w-3" /> Retry
        </Button>
      )}
    </div>
  );
}

/** StatCard — compact metric with icon, title, value, optional trend/color */
export function StatCard({
  icon: Icon, title, value, sub, tone = 'neutral', valueClass, className,
}: {
  icon: React.ElementType;
  title: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: AccentTone;
  valueClass?: string;
  className?: string;
}) {
  const t = CARD_TONE[tone];
  return (
    <Card className={cn('group relative overflow-hidden', t.border, t.restShadow, className)}>
      <span aria-hidden className={`absolute inset-x-0 top-0 h-[2px] ${t.bar}`} />
      <CardContent className="relative flex items-center gap-3 px-3.5 py-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${t.icon}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-muted-foreground">{title}</p>
          <p className={cn('truncate text-lg font-semibold tabular-nums leading-6', valueClass)}>{value}</p>
          {sub != null && <p className="truncate text-[10px] text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Formatting helpers shared across live/stock views (Indian locale). */
export const fmtPrice = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtNumber = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN');
export const fmtCompact = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return String(v);
};
/** Change coloring class — undefined for unavailable so nothing is faked. */
export const changeTone = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return 'text-muted-foreground';
  if (v > 0) return 'text-success';
  if (v < 0) return 'text-destructive';
  return 'text-muted-foreground';
};
export const sign = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '';
  return v > 0 ? '+' : '';
};

/** LiveIndicator — pulsing green when live, muted otherwise. */
export function LiveIndicator({
  live, label, className,
}: {
  live: boolean; label?: string; className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium tabular-nums', className)}>
      <span className={cn(
        'h-1.5 w-1.5 rounded-full shrink-0',
        live ? 'bg-success animate-pulse' : 'bg-muted-foreground/50',
      )} />
      <span className={live ? 'text-success' : 'text-muted-foreground'}>
        {label ?? (live ? 'Live' : 'Offline')}
      </span>
    </span>
  );
}
