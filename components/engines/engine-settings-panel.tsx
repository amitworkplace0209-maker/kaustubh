'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Loader2, Lock, RotateCcw, Save, Sliders,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { SectionCard } from '@/components/design-system';
import { cn } from '@/lib/utils';
import {
  engineConfigPath, saveEngineConfig, usePoll,
  type EngineConfig, type EngineConfigField,
} from '@/lib/system-engines';

/**
 * Generic engine settings form.
 *
 * Renders whatever schema the engine declares, so adding a setting to an engine
 * is a backend-only change — this form needs no per-engine code. It is bound to
 * the real endpoints (`GET`/`PATCH /api/services/engines/{id}/config`).
 *
 * Two rules this component exists to enforce:
 *  1. A computed output is shown as a fact, never as an input. Fields the engine
 *     marks non-editable render read-only, so there is no control that silently
 *     does nothing.
 *  2. A value is only reported as saved when the backend confirmed the write.
 *     `pending` fields say "saved, engine has not taken it up yet" instead of
 *     claiming success.
 */

type Draft = Record<string, string | boolean>;

function toDraft(fields: EngineConfigField[]): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    if (!f.editable || !f.key) continue;
    if (f.type === 'boolean') {
      draft[f.key] = f.value === true || f.value === 'true';
    } else {
      draft[f.key] = f.value == null ? '' : String(f.value);
    }
  }
  return draft;
}

function renderValue(field: EngineConfigField): string {
  const v = field.applied ?? field.value;
  if (v == null || v === '') return 'N/A';
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : 'none';
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return 'none';
    return entries.map(([k, val]) => `${k}: ${String(val)}`).join(', ');
  }
  return String(v);
}

export function EngineSettingsPanel({
  engineId,
  engineName,
  compact = false,
}: {
  engineId: string;
  engineName?: string;
  compact?: boolean;
}) {
  const { data, error, refresh } = usePoll<EngineConfig>(engineConfigPath(engineId), 15000);
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Seed the form from the server, but never clobber an edit in progress.
  useEffect(() => {
    if (!data?.fields) return;
    setDraft((prev) => {
      const next = toDraft(data.fields);
      for (const key of Object.keys(prev)) {
        if (dirty[key]) next[key] = prev[key];
      }
      return next;
    });
  }, [data, dirty]);

  const editable = useMemo(
    () => (data?.fields ?? []).filter((f) => f.editable && f.key),
    [data],
  );
  const readOnly = useMemo(
    () => (data?.fields ?? []).filter((f) => !f.editable),
    [data],
  );
  const groups = useMemo(() => {
    const map = new Map<string, EngineConfigField[]>();
    for (const f of editable) {
      const g = f.group || 'General';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(f);
    }
    return [...map.entries()];
  }, [editable]);

  const changedCount = Object.keys(dirty).filter((k) => dirty[k]).length;

  const setValue = useCallback((key: string, value: string | boolean) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setDirty((prev) => ({ ...prev, [key]: true }));
    setSaveResult(null);
    setFieldErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    if (!data) return;
    const patch: Record<string, unknown> = {};
    for (const key of Object.keys(dirty)) {
      if (!dirty[key]) continue;
      const field = editable.find((f) => f.key === key);
      if (!field) continue;
      const raw = draft[key];
      if (field.type === 'boolean') {
        patch[key] = raw === true || raw === 'true';
      } else if (field.type === 'number') {
        const num = Number(raw);
        // A blank or non-numeric box is reported rather than coerced to 0.
        if (raw === '' || !Number.isFinite(num)) {
          setFieldErrors((prev) => ({ ...prev, [key]: 'Enter a number' }));
          continue;
        }
        patch[key] = num;
      } else {
        patch[key] = raw;
      }
    }
    if (!Object.keys(patch).length) return;

    setSaving(true);
    setSaveResult(null);
    const res = await saveEngineConfig(engineId, patch);
    setSaving(false);

    if (res.ok) {
      const written = Object.keys(res.written ?? patch).length;
      setFieldErrors({});
      setDirty({});
      setSaveResult({
        ok: true,
        message: `Saved ${written} setting${written === 1 ? '' : 's'}.`,
      });
      refresh();
    } else {
      const errs = res.errors ?? {};
      setFieldErrors(errs);
      const general = errs['*'];
      setSaveResult({
        ok: false,
        message: general
          ? general
          : `${Object.keys(errs).length} setting${Object.keys(errs).length === 1 ? '' : 's'} refused — see the field.`,
      });
    }
  }, [data, dirty, draft, editable, engineId, refresh]);

  const reset = useCallback(() => {
    if (!data?.fields) return;
    setDraft(toDraft(data.fields));
    setDirty({});
    setFieldErrors({});
    setSaveResult(null);
  }, [data]);

  if (error) {
    return (
      <SectionCard title="Settings">
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-xs text-destructive/90">
            Could not load {engineName ?? engineId} settings: {error}
          </p>
        </div>
      </SectionCard>
    );
  }

  if (!data) {
    return (
      <SectionCard title="Settings">
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading settings…
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Settings"
      headerRight={
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {data.editable} editable · {data.readOnly} read-only
        </span>
      }
    >
      <div className="space-y-4">
        {/* ---------- writable ---------- */}
        {editable.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This engine exposes no operator settings — everything it reports is a
            computed fact shown below.
          </p>
        ) : (
          groups.map(([group, fields]) => (
            <div key={group} className="space-y-2.5">
              {groups.length > 1 && (
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group}
                </h4>
              )}
              <div className={cn('grid gap-2.5', compact ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
                {fields.map((f) => {
                  const fieldError = fieldErrors[f.key];
                  const value = draft[f.key];
                  return (
                    <div key={f.key} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`cfg-${f.key}`} className="text-[11px] text-muted-foreground">
                          {f.label}
                          {f.unit ? <span className="ml-1 opacity-70">({f.unit})</span> : null}
                        </Label>
                        {f.pending && (
                          <Badge className="h-4 border-warning/40 bg-warning/15 px-1.5 text-[9px] text-warning">
                            pending restart
                          </Badge>
                        )}
                      </div>

                      {f.type === 'boolean' ? (
                        <div className="flex items-center gap-2 pt-1">
                          <Switch
                            id={`cfg-${f.key}`}
                            checked={value === true}
                            onCheckedChange={(v) => setValue(f.key, v)}
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {value === true ? 'Enabled' : 'Disabled'}
                          </span>
                        </div>
                      ) : f.type === 'select' ? (
                        <Select
                          value={typeof value === 'string' ? value : ''}
                          onValueChange={(v) => setValue(f.key, v)}
                        >
                          <SelectTrigger id={`cfg-${f.key}`} className="h-8 text-xs">
                            <SelectValue placeholder="Select" />
                          </SelectTrigger>
                          <SelectContent>
                            {f.options.map((o) => (
                              <SelectItem key={String(o)} value={String(o)} className="text-xs">
                                {String(o)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          id={`cfg-${f.key}`}
                          type={f.type === 'number' ? 'number' : 'text'}
                          className="h-8 text-xs tabular-nums"
                          value={typeof value === 'string' ? value : ''}
                          min={f.min ?? undefined}
                          max={f.max ?? undefined}
                          step={f.step ?? undefined}
                          onChange={(e) => setValue(f.key, e.target.value)}
                        />
                      )}

                      {f.help && !fieldError && (
                        <p className="text-[10px] leading-relaxed text-muted-foreground/70">{f.help}</p>
                      )}
                      {fieldError && (
                        <p className="text-[10px] font-medium text-destructive">{fieldError}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}

        {/* ---------- actions ---------- */}
        {editable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button size="sm" className="gap-1.5" onClick={save} disabled={saving || changedCount === 0}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save{changedCount > 0 ? ` (${changedCount})` : ''}
            </Button>
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={reset} disabled={saving || changedCount === 0}>
              <RotateCcw className="h-3.5 w-3.5" /> Discard
            </Button>
            {saveResult && (
              <span className={saveResult.ok ? 'text-[11px] text-success' : 'text-[11px] text-destructive'}>
                {saveResult.message}
              </span>
            )}
          </div>
        )}

        {/* ---------- computed facts ---------- */}
        {readOnly.length > 0 && (
          <div className="space-y-2 border-t border-border/60 pt-3">
            <div className="flex items-center gap-1.5">
              <Lock className="h-3 w-3 text-muted-foreground" />
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Reported by the engine
              </h4>
            </div>
            <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {readOnly.map((f) => (
                <div
                  key={f.summary || f.label}
                  className="flex items-start justify-between gap-2 text-[11px]"
                >
                  <dt className="min-w-0 truncate text-muted-foreground">{f.label}</dt>
                  <dd className="max-w-[60%] break-words text-right font-mono">
                    {renderValue(f)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {editable.length === 0 && readOnly.length === 0 && (
          <p className="text-xs text-muted-foreground">This engine reports no configuration.</p>
        )}
      </div>
    </SectionCard>
  );
}

/** Compact inline variant used inside engine cards on the control center. */
export function EngineSettingsInline({ engineId }: { engineId: string }) {
  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-background/40 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <Sliders className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </span>
      </div>
      <EngineSettingsPanel engineId={engineId} compact />
    </div>
  );
}