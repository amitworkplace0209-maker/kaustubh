'use client';

import { AlertTriangle, Check, Loader2, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/design-system';
import type { SettingsApply, SettingsFieldDef } from '@/lib/settings/types';
import { resetSettingValue, setSettingValue, useSettings } from '@/lib/settings/store';

// ---------------------------------------------------------------------------
// Apply policy badge — truthful, never claims a live effect that isn't real.
// ---------------------------------------------------------------------------
export function ApplyBadge({ apply }: { apply?: SettingsApply }) {
  if (!apply) return null;
  if (apply === 'live') {
    return <StatusBadge status="success" label="Live · applies now" />;
  }
  if (apply === 'restart') {
    return <StatusBadge status="warning" label="Applies on restart" />;
  }
  return <StatusBadge status="neutral" label="Saved" />;
}

// ---------------------------------------------------------------------------
// The actual control. Pure, controlled — parent owns value+onChange.
// ---------------------------------------------------------------------------
export function SettingControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: SettingsFieldDef;
  value: any;
  onChange: (v: any) => void;
  disabled?: boolean;
}) {
  if (field.readOnly) {
    return (
      <span className={cn('text-sm font-medium tabular-nums', value ? 'text-success' : 'text-muted-foreground')}>
        {value ? 'Supported' : 'Not available'}
      </span>
    );
  }
  if (field.type === 'boolean') {
    return (
      <button
        role="switch"
        aria-checked={Boolean(value)}
        aria-label={field.label}
        disabled={disabled}
        onClick={() => onChange(!Boolean(value))}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50',
          value ? 'border-amber-500/40 bg-amber-500' : 'border-border bg-muted',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-background shadow-sm transition-transform',
            value ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </button>
    );
  }
  if (field.type === 'select') {
    return (
      <select
        aria-label={field.label}
        disabled={disabled}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full max-w-xs rounded-lg border border-input bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
      >
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'number') {
    return (
      <div className="flex items-center gap-2">
        <Input
          type="number"
          aria-label={field.label}
          disabled={disabled}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          defaultValue={value ?? ''}
          key={String(value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = Number((e.target as HTMLInputElement).value);
              if (!Number.isNaN(n)) onChange(n);
            }
          }}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (!Number.isNaN(n) && n !== Number(value)) onChange(n);
          }}
          className="h-9 w-28 text-right tabular-nums"
        />
        {field.unit ? <span className="text-xs text-muted-foreground">{field.unit}</span> : null}
      </div>
    );
  }
  if (field.type === 'color') {
    const hex = /^#[0-9a-fA-F]{6}$/.test(String(value ?? '')) ? String(value) : '#F59E0B';
    return (
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={field.label}
          disabled={disabled}
          value={hex}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-11 cursor-pointer rounded border border-input bg-background p-0.5 disabled:opacity-50"
        />
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{hex}</span>
      </div>
    );
  }
  if (field.type === 'time') {
    return (
      <Input
        type="time"
        aria-label={field.label}
        disabled={disabled}
        value={String(value ?? '09:00')}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-32 font-mono tabular-nums"
      />
    );
  }
  // string / masked
  return (
    <Input
      type={field.sensitive ? 'password' : 'text'}
      aria-label={field.label}
      disabled={disabled}
      placeholder={field.placeholder}
      defaultValue={String(value ?? '')}
      key={String(value)}
      onBlur={(e) => {
        if (e.target.value !== String(value ?? '')) onChange(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if ((e.target as HTMLInputElement).value !== String(value ?? '')) {
            onChange((e.target as HTMLInputElement).value);
          }
        }
      }}
      className="h-9 w-full max-w-xs"
    />
  );
}

// ---------------------------------------------------------------------------
// One persisted setting row: label + description + control + state.
// ---------------------------------------------------------------------------
export function SettingRow({
  field,
}: {
  field: SettingsFieldDef;
}) {
  const { settings, pending, errors, liveKeys } = useSettings();
  const value = settings[field.sourceKey];
  const saving = field.sourceKey in pending;
  const error = errors[field.sourceKey];
  const apply: SettingsApply = field.apply ?? (liveKeys.has(field.sourceKey) ? 'live' : 'saved');

  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 pr-4">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{field.label}</p>
          {field.readOnly ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">status</span>
          ) : (
            <div className="flex items-center gap-1.5">
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
              ) : error ? (
                <X className="h-3 w-3 text-destructive" />
              ) : (
                <Check className="h-3 w-3 text-success" />
              )}
              <ApplyBadge apply={apply} />
            </div>
          )}
        </div>
        {field.description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">{field.description}</p>
        ) : null}
        {error ? <p className="mt-1 text-[11px] text-destructive">{error}</p> : null}
      </div>
      <div className="shrink-0">
        <SettingControl
          field={field}
          value={value}
          onChange={(v) => void setSettingValue(field.sourceKey, v)}
          disabled={field.readOnly || Boolean(error)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A sub-group card (label + rows).
// ---------------------------------------------------------------------------
export function SettingGroupCard({
  group,
}: {
  group: SettingsSectionGroupLike;
}) {
  if (!group.fields.length) return null;
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="border-b border-border/60 px-4 py-3">
        <p className="text-sm font-semibold">{group.label}</p>
        {group.description ? (
          <p className="mt-0.5 text-xs text-muted-foreground/80">{group.description}</p>
        ) : null}
      </header>
      <div className="divide-y divide-border/60 px-4">
        {group.fields.map((f) => (
          <SettingRow key={f.key} field={f} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Danger zone container for destructive actions.
// ---------------------------------------------------------------------------
export function DangerZone({ title = 'Danger zone', children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-destructive/30 bg-destructive/5">
      <header className="border-b border-destructive/20 px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <p className="text-sm font-semibold text-destructive">{title}</p>
        </div>
      </header>
      <div className="space-y-3 px-4 py-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reset control for a single field (saved as a row-level affordance).
// ---------------------------------------------------------------------------
export function ResetFieldButton({ field }: { field: SettingsFieldDef }) {
  const onReset = () => void resetSettingValue(field.sourceKey);
  return (
    <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={onReset}>
      <RotateCcw className="h-3 w-3 mr-1" /> Default
    </Button>
  );
}

type SettingsSectionGroupLike = { label: string; description?: string; fields: SettingsFieldDef[] };