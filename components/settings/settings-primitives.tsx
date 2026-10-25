'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  Info,
  Loader2,
  Search,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'purple';

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
  info: 'text-info',
  purple: 'text-purple',
};

const TONE_SURFACE: Record<Tone, string> = {
  neutral: 'border-border/60 bg-muted/30 text-muted-foreground',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-info/30 bg-info/10 text-info',
  purple: 'border-purple/30 bg-purple/10 text-purple',
};

const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/60',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  info: 'bg-info',
  purple: 'bg-purple',
};

export function toneText(tone: Tone): string {
  return TONE_TEXT[tone];
}

export function Pill({
  tone = 'neutral',
  children,
  dot = false,
  className,
  title,
}: {
  tone?: Tone;
  children: React.ReactNode;
  dot?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-4',
        TONE_SURFACE[tone],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} />}
      {children}
    </span>
  );
}

export function Panel({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  bodyClassName,
  footer,
  tone,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ElementType;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  footer?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-xl border border-border/60 bg-card/60 shadow-sm',
        className,
      )}
    >
      {tone && <span aria-hidden className={cn('absolute inset-x-0 top-0 h-0.5', TONE_DOT[tone])} />}
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border/50 px-4 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            {Icon && (
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-inset ring-border/50">
                <Icon className="h-3.5 w-3.5" />
              </span>
            )}
            <div className="min-w-0">
              <h3 className="text-[13px] font-semibold leading-5">{title}</h3>
              {description && (
                <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
      {footer && (
        <footer className="border-t border-border/50 bg-muted/20 px-4 py-2.5">{footer}</footer>
      )}
    </section>
  );
}

export function SectionIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
            {eyebrow}
          </div>
        )}
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {description && (
          <p className="mt-0.5 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function FieldRow({
  label,
  hint,
  description,
  children,
  saved,
  dirty,
  error,
  disabled,
  className,
  controlClassName,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  saved?: boolean;
  dirty?: boolean;
  error?: string | null;
  disabled?: boolean;
  className?: string;
  controlClassName?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-5',
        disabled && 'opacity-50',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium leading-5">{label}</span>
          {hint && <span className="text-[10px] text-muted-foreground/80">{hint}</span>}
          {dirty && <Pill tone="warning">unsaved</Pill>}
          {saved && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-success">
              <Check className="h-3 w-3" /> saved
            </span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</p>
        )}
        {error && <p className="mt-1 text-[10px] font-medium text-destructive">{error}</p>}
      </div>
      <div className={cn('flex shrink-0 items-center gap-2', controlClassName)}>{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  size = 'sm',
  tone = 'primary',
  className,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: React.ReactNode; title?: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: 'sm' | 'xs';
  tone?: 'primary' | 'success' | 'danger' | 'warning';
  className?: string;
}) {
  const activeTone = {
    primary: 'border-primary/40 bg-primary/15 text-primary',
    success: 'border-success/40 bg-success/15 text-success',
    danger: 'border-destructive/40 bg-destructive/15 text-destructive',
    warning: 'border-warning/40 bg-warning/15 text-warning',
  }[tone];
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-lg border border-border/60 bg-muted/30 p-0.5',
        className,
      )}
      role="group"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md border font-medium transition-colors disabled:cursor-not-allowed',
            size === 'xs' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
            value === option.value
              ? activeTone
              : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function NumberControl({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  width = 'w-24',
  disabled,
  prefix,
  onCommit,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  width?: string;
  disabled?: boolean;
  prefix?: string;
  onCommit?: () => void;
}) {
  const [buffer, setBuffer] = React.useState(String(value));
  React.useEffect(() => {
    setBuffer(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setBuffer(String(value));
      return;
    }
    const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n));
    setBuffer(String(clamped));
    if (clamped !== value) onChange(clamped);
    onCommit?.();
  };

  return (
    <div className="flex items-center gap-1">
      {prefix && <span className="text-[10px] text-muted-foreground">{prefix}</span>}
      <Input
        type="number"
        inputMode="decimal"
        value={buffer}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          setBuffer(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) {
            onChange(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, n)));
          }
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
        }}
        className={cn('h-8 px-2 text-center font-mono text-xs', width)}
      />
      {unit && <span className="min-w-3 text-[10px] text-muted-foreground">{unit}</span>}
    </div>
  );
}

export function SelectControl({
  value,
  onChange,
  options,
  disabled,
  width = 'w-36',
  placeholder = 'Select…',
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  width?: string;
  placeholder?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn('h-8 text-xs', width)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ToggleRow({
  label,
  description,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={label} description={description} hint={hint} disabled={disabled}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </FieldRow>
  );
}

export function StatTile({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ElementType;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-xl border border-border/60 bg-card/60 px-3.5 py-3',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
            {label}
          </p>
          <p className={cn('mt-1 truncate text-lg font-bold leading-6 tabular-nums', TONE_TEXT[tone])}>
            {value}
          </p>
          {sub != null && <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{sub}</p>}
        </div>
        {Icon && (
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
              TONE_SURFACE[tone],
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
    </div>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
  className,
  icon: Icon,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  icon?: React.ElementType;
}) {
  const FallbackIcon =
    tone === 'danger' || tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
  const IconComp = Icon ?? FallbackIcon;
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[11px] leading-5',
        TONE_SURFACE[tone],
        className,
      )}
    >
      <IconComp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        <div className={cn(title ? 'text-muted-foreground' : undefined)}>{children}</div>
      </div>
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search…',
  className,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 pr-7 text-xs"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function SaveDot({
  state,
  label,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error';
  label?: string;
}) {
  if (state === 'idle') return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
        state === 'saving' && 'border-info/30 bg-info/10 text-info',
        state === 'saved' && 'border-success/30 bg-success/10 text-success',
        state === 'error' && 'border-destructive/30 bg-destructive/10 text-destructive',
      )}
    >
      {state === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
      {state === 'saved' && <Check className="h-3 w-3" />}
      {state === 'error' && <AlertTriangle className="h-3 w-3" />}
      {label ?? (state === 'saving' ? 'Saving' : state === 'saved' ? 'Saved' : 'Failed')}
    </span>
  );
}

export function InlineLink({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-medium text-primary hover:underline',
        className,
      )}
    >
      {children}
      <ChevronRight className="h-3 w-3" />
    </button>
  );
}

export function EmptyHint({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/70 px-4 py-8 text-center">
      <Icon className="mb-2 h-6 w-6 text-muted-foreground/40" />
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[10px] text-muted-foreground/70">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function formatRelative(ts: string | null | undefined): string {
  if (!ts) return '—';
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time)) return '—';
  const delta = Date.now() - time;
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  if (delta < 604_800_000) return `${Math.max(1, Math.round(delta / 86_400_000))}d ago`;
  return new Date(time).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function formatValue(value: any): string {
  if (value == null) return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object' && a && b) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

export function classifyAction(action: string | null | undefined): Tone {
  switch (action) {
    case 'reset':
    case 'reset-all':
    case 'reset-category':
      return 'warning';
    case 'import':
      return 'info';
    case 'import-rejected':
      return 'danger';
    default:
      return 'success';
  }
}
