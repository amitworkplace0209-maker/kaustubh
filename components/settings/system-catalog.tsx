'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Database,
  Download,
  Filter,
  Loader2,
  RotateCcw,
  Save,
  SearchX,
  ShieldAlert,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  patchSettings,
  resetSetting,
  resetSettingsCategory,
  type SettingSchemaRow,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Callout,
  EmptyHint,
  FieldRow,
  NumberControl,
  Panel,
  Pill,
  SaveDot,
  SearchField,
  SectionIntro,
  formatRelative,
  formatValue,
  valuesEqual,
} from './settings-primitives';

const CATEGORY_LABELS: Record<string, string> = {
  profile: 'Profile',
  theme: 'Theme',
  trading: 'Trading',
  python: 'Python Engine',
  data_saver: 'Data Saver',
  mongodb: 'MongoDB',
  download: 'Downloads',
  log: 'Logging',
  notification: 'Notifications',
  security: 'Security',
  market_watch: 'Market Watch',
  market_data: 'Market Data',
  websocket: 'WebSocket',
  scheduler: 'Scheduler',
  general: 'General',
  appearance: 'Appearance',
  engine: 'Order Engine',
  alert: 'Alerts',
  database: 'Database',
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SystemCatalog({
  schema,
  categories,
  loading,
  onRefresh,
  focusCategory,
  onFocusConsumed,
}: {
  schema: SettingSchemaRow[];
  categories: string[];
  loading: boolean;
  onRefresh: () => Promise<void> | void;
  focusCategory?: string | null;
  onFocusConsumed?: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [onlyModified, setOnlyModified] = useState(false);
  const [onlyLive, setOnlyLive] = useState(false);
  const [staged, setStaged] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (focusCategory) {
      setCategory(focusCategory);
      onFocusConsumed?.();
    }
  }, [focusCategory, onFocusConsumed]);

  const byKey = useMemo(() => new Map(schema.map((row) => [row.key, row])), [schema]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return schema.filter((row) => {
      if (category !== 'all' && row.category !== category) return false;
      if (onlyModified && valuesEqual(row.value, row.default)) return false;
      if (onlyLive && !row.live) return false;
      if (!q) return true;
      return (
        row.key.toLowerCase().includes(q) ||
        row.description.toLowerCase().includes(q) ||
        row.category.toLowerCase().includes(q) ||
        String(row.value ?? '').toLowerCase().includes(q)
      );
    });
  }, [schema, search, category, onlyModified, onlyLive]);

  const grouped = useMemo(() => {
    const map = new Map<string, SettingSchemaRow[]>();
    for (const row of filtered) {
      const list = map.get(row.category);
      if (list) list.push(row);
      else map.set(row.category, [row]);
    }
    return [...map.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [filtered]);

  const dirtyKeys = Object.keys(staged);
  const modifiedCount = schema.filter((row) => !valuesEqual(row.value, row.default)).length;
  const sensitiveCount = schema.filter((row) => row.sensitive).length;

  const getValue = (row: SettingSchemaRow) => (row.key in staged ? staged[row.key] : row.value);

  const stage = (row: SettingSchemaRow, value: any) => {
    setStaged((prev) => {
      const next = { ...prev };
      if (valuesEqual(value, row.value)) delete next[row.key];
      else next[row.key] = value;
      return next;
    });
    setSaveState('idle');
  };

  const discard = () => {
    setStaged({});
    setError(null);
    setSaveState('idle');
  };

  const save = async () => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setSaveState('saving');
    setError(null);
    try {
      await patchSettings(staged);
      setStaged({});
      setSaveState('saved');
      toast({
        title: 'Settings saved',
        description: `${dirtyKeys.length} backend key${dirtyKeys.length === 1 ? '' : 's'} updated atomically.`,
      });
      await onRefresh();
      window.setTimeout(() => setSaveState('idle'), 1800);
    } catch (err) {
      setSaveState('error');
      const message = err instanceof Error ? err.message : 'Save failed';
      setError(message.length > 320 ? `${message.slice(0, 320)}…` : message);
      toast({ title: 'Settings rejected', description: 'No keys were written.', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const resetKey = async (key: string) => {
    try {
      await resetSetting(key);
      setStaged((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast({ title: 'Setting reset', description: key });
      await onRefresh();
    } catch (err) {
      toast({
        title: 'Reset failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  };

  const resetCategory = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      await resetSettingsCategory(resetTarget);
      setStaged((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (byKey.get(key)?.category === resetTarget) delete next[key];
        }
        return next;
      });
      toast({ title: `${categoryLabel(resetTarget)} reset`, description: 'All keys in the category are back to defaults.' });
      setResetTarget(null);
      await onRefresh();
    } catch (err) {
      toast({
        title: 'Category reset failed',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="space-y-4 pb-16">
      <SectionIntro
        eyebrow="Backend catalogue"
        title="System Settings"
        description="Every backend key with its declared type, bounds and runtime effect. Edits are staged locally and written as one atomic patch."
        actions={
          <>
            <SaveDot state={saveState} />
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => downloadJson(`settings-catalog-${new Date().toISOString().slice(0, 10)}.json`, schema)}
            >
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => void onRefresh()}>
              <RotateCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
            </Button>
          </>
        }
      />

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="Catalogued keys" value={schema.length} icon={Database} />
        <MiniStat label="Customized" value={modifiedCount} icon={SlidersHorizontal} tone="warning" />
        <MiniStat label="Live runtime" value={schema.filter((row) => row.live).length} icon={Activity} tone="success" />
        <MiniStat label="Sensitive" value={sensitiveCount} icon={ShieldAlert} tone="danger" />
      </div>

      <Panel bodyClassName="p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search key, description, value or category…"
              className="min-w-[220px] flex-1"
            />
            <Button
              size="sm"
              variant={onlyModified ? 'secondary' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setOnlyModified((v) => !v)}
            >
              <Filter className="mr-1 h-3 w-3" /> Modified
            </Button>
            <Button
              size="sm"
              variant={onlyLive ? 'secondary' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setOnlyLive((v) => !v)}
            >
              <Activity className="mr-1 h-3 w-3" /> Live
            </Button>
          </div>

          <div className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
            <CategoryChip
              active={category === 'all'}
              label="All"
              count={schema.length}
              onClick={() => setCategory('all')}
            />
            {categories.map((c) => {
              const count = schema.filter((row) => row.category === c).length;
              if (count === 0) return null;
              return (
                <CategoryChip
                  key={c}
                  active={category === c}
                  label={categoryLabel(c)}
                  count={count}
                  onClick={() => setCategory(c)}
                />
              );
            })}
          </div>
        </div>
      </Panel>

      {error && (
        <Callout tone="danger" title="The patch was rejected — nothing was written">
          <span className="font-mono text-[10px]">{error}</span>
        </Callout>
      )}

      {loading && schema.length === 0 ? (
        <Panel>
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the backend catalogue…
          </div>
        </Panel>
      ) : grouped.length === 0 ? (
        <Panel>
          <EmptyHint
            icon={SearchX}
            title="No settings match the current filters"
            description="Try clearing the search, switching category or disabling the Modified/Live filters."
            action={
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => {
                  setSearch('');
                  setCategory('all');
                  setOnlyModified(false);
                  setOnlyLive(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          {grouped.map(([group, rows]) => {
            const groupDirty = rows.filter((row) => row.key in staged).length;
            const groupModified = rows.filter((row) => !valuesEqual(row.value, row.default)).length;
            return (
              <Panel
                key={group}
                title={categoryLabel(group)}
                description={`${rows.length} key${rows.length === 1 ? '' : 's'}${
                  groupModified ? ` · ${groupModified} customized` : ''
                }`}
                icon={Database}
                actions={
                  <>
                    {groupDirty > 0 && <Pill tone="warning">{groupDirty} staged</Pill>}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[10px] text-muted-foreground"
                      onClick={() => setResetTarget(group)}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" /> Reset category
                    </Button>
                  </>
                }
                bodyClassName="p-0"
              >
                <div className="divide-y divide-border/40">
                  {rows.map((row) => {
                    const value = getValue(row);
                    const isStaged = row.key in staged;
                    return (
                      <CatalogRow
                        key={row.key}
                        row={row}
                        value={value}
                        staged={isStaged}
                        onChange={(next) => stage(row, next)}
                        onReset={() => void resetKey(row.key)}
                      />
                    );
                  })}
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {dirtyKeys.length > 0 && (
        <div className="sticky bottom-2 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
            <AlertTriangle className="h-3.5 w-3.5" />
            {dirtyKeys.length} unsaved key{dirtyKeys.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={discard} disabled={saving}>
              <Undo2 className="mr-1 h-3 w-3" /> Discard
            </Button>
            <Button size="sm" className="h-7 text-[11px]" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
              Save patch
            </Button>
          </div>
        </div>
      )}

      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Reset {resetTarget ? categoryLabel(resetTarget) : 'category'}?</DialogTitle>
            <DialogDescription className="text-xs">
              Every key in this category goes back to its declared default and the live runtime refreshes
              immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)} disabled={resetting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={resetCategory} disabled={resetting}>
              {resetting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Reset category
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MiniStat({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  tone?: 'neutral' | 'warning' | 'success' | 'danger';
}) {
  const toneClass = {
    neutral: 'text-foreground',
    warning: 'text-warning',
    success: 'text-success',
    danger: 'text-destructive',
  }[tone];
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className={cn('text-base font-bold leading-5 tabular-nums', toneClass)}>{value}</div>
        <div className="truncate text-[10px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function CategoryChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
        active
          ? 'border-primary/40 bg-primary/15 text-primary'
          : 'border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {label}
      <span className={cn('rounded-full px-1 text-[9px] tabular-nums', active ? 'bg-primary/20' : 'bg-muted/70')}>
        {count}
      </span>
    </button>
  );
}

function CatalogRow({
  row,
  value,
  staged,
  onChange,
  onReset,
}: {
  row: SettingSchemaRow;
  value: any;
  staged: boolean;
  onChange: (value: any) => void;
  onReset: () => void;
}) {
  const isModified = !valuesEqual(row.value, row.default);
  const control = () => {
    if (row.sensitive) {
      return (
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">••••••••</span>
          <Pill tone="danger">hidden</Pill>
        </div>
      );
    }
    if (row.type === 'boolean') {
      return <Switch checked={Boolean(value)} onCheckedChange={onChange} />;
    }
    if (row.type === 'number') {
      const step = Number.isInteger(row.default) && Number.isInteger(row.min ?? 0) ? 1 : 0.1;
      return (
        <NumberControl
          value={Number(value) || 0}
          onChange={onChange}
          min={row.min ?? undefined}
          max={row.max ?? undefined}
          step={step}
          unit={row.unit ?? undefined}
          width="w-24"
        />
      );
    }
    if (row.options && row.options.length > 0) {
      return (
        <Select value={String(value ?? '')} onValueChange={onChange}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {row.options.map((option) => (
              <SelectItem key={String(option)} value={String(option)} className="text-xs">
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    if (row.type === 'text') {
      return (
        <Input
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-56 text-xs"
        />
      );
    }
    return (
      <Input
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-48 font-mono text-xs"
      />
    );
  };

  return (
    <div className="group px-4 py-1">
      <FieldRow
        label={<span className="font-mono text-[11px]">{row.key}</span>}
        hint={
          <>
            {row.unit ? `· ${row.unit}` : ''}
            {row.min != null || row.max != null ? ` · ${row.min ?? '−∞'}…${row.max ?? '∞'}` : ''}
          </>
        }
        description={row.description}
        dirty={staged}
        saved={isModified && !staged}
        controlClassName="flex-wrap justify-end"
      >
        <div className="flex items-center gap-1.5">
          {row.live && <Pill tone="success" title="Applied to the live runtime immediately">live</Pill>}
          {isModified && !staged && <Pill tone="info">custom</Pill>}
          {control()}
          {!row.sensitive && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              title="Reset this key to default"
              onClick={onReset}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          )}
        </div>
      </FieldRow>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pb-1 text-[9px] text-muted-foreground/70">
        <span>default: <span className="font-mono">{row.sensitive ? '••••' : formatValue(row.default)}</span></span>
        {row.updatedAt && <span>updated {formatRelative(row.updatedAt)}</span>}
        <span className="ml-auto">{row.type}</span>
      </div>
    </div>
  );
}
