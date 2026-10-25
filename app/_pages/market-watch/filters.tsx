'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Filter, Plus, Trash2, Save, Play, ListFilter, RefreshCw, Rows3, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SectionCard, LoadingState, EmptyState, ErrorState,
} from '@/components/design-system';
import {
  ConfigResponse, FilterCatalogEntry, FilterCriterion, SavedFilter, SavedFilterDetail,
  MWRow, fetchJson,
} from './mw-shared';
import { MwRowRow, MwTableShell } from './mw-table';

interface ApplyResponse {
  ok: boolean;
  criteria: FilterCriterion[];
  offset: number;
  limit: number;
  count: number;
  total: number;
  hasMore: boolean;
  items: MWRow[];
  sortBy?: string;
  sortDir?: string;
}

const RANGE_OPS = [
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'eq', label: '=' },
  { value: 'between', label: 'between' },
];
const ENUM_OPS = [
  { value: 'in', label: 'in' },
  { value: 'neq', label: 'not in' },
];

/**
 * One-click preset screens. Every preset is just a validated criteria list —
 * it is sent to the SAME backend `/filters/apply` endpoint as the builder, so
 * the browser never ranks, filters or computes a value itself (doc §24).
 *
 * Momentum presets read the backend's flat per-timeframe % fields
 * (`change_1m_pct` / `change_5m_pct` / `change_10m_pct` / `change_30m_pct`),
 * which is exactly what "change 1% in 5 minutes" means.
 */
type PresetGroup = 'Momentum' | 'Day move' | 'Volume & liquidity' | 'Price band' | 'Quality';

interface Preset {
  id: string;
  group: PresetGroup;
  label: string;
  hint: string;
  criteria: FilterCriterion[];
}

const PRESET_GROUPS: PresetGroup[] = ['Momentum', 'Day move', 'Volume & liquidity', 'Price band', 'Quality'];

const PRESETS: Preset[] = [
  // ---- momentum: "change X% in N minutes" -------------------------------- #
  { id: 'm1-1m', group: 'Momentum', label: '↑ 1% in 1 min', hint: 'Fast intraday burst', criteria: [{ key: 'momentum_1m', op: 'gte', value: 1 }] },
  { id: 'm1-5m', group: 'Momentum', label: '↑ 1% in 5 min', hint: 'The classic 5-minute move screen', criteria: [{ key: 'momentum_5m', op: 'gte', value: 1 }] },
  { id: 'm2-5m', group: 'Momentum', label: '↑ 2% in 5 min', hint: 'Stronger 5-minute momentum', criteria: [{ key: 'momentum_5m', op: 'gte', value: 2 }] },
  { id: 'm1-10m', group: 'Momentum', label: '↑ 1% in 10 min', hint: 'Sustained 10-minute move', criteria: [{ key: 'momentum_10m', op: 'gte', value: 1 }] },
  { id: 'm1-30m', group: 'Momentum', label: '↑ 1% in 30 min', hint: 'Half-hour trend', criteria: [{ key: 'momentum_30m', op: 'gte', value: 1 }] },
  { id: 'd1-5m', group: 'Momentum', label: '↓ 1% in 5 min', hint: '5-minute reversal / breakdown', criteria: [{ key: 'momentum_5m', op: 'lte', value: -1 }] },
  { id: 'd2-5m', group: 'Momentum', label: '↓ 2% in 5 min', hint: 'Sharp 5-minute sell-off', criteria: [{ key: 'momentum_5m', op: 'lte', value: -2 }] },

  // ---- day move ---------------------------------------------------------- #
  { id: 'g1', group: 'Day move', label: 'Gainers ≥ 1%', hint: 'Up on the day', criteria: [{ key: 'change_pct', op: 'gte', value: 1 }] },
  { id: 'g3', group: 'Day move', label: 'Gainers ≥ 3%', hint: 'Strong day gainers', criteria: [{ key: 'change_pct', op: 'gte', value: 3 }] },
  { id: 'g5', group: 'Day move', label: 'Gainers ≥ 5%', hint: 'Big day moves', criteria: [{ key: 'change_pct', op: 'gte', value: 5 }] },
  { id: 'l1', group: 'Day move', label: 'Losers ≤ -1%', hint: 'Down on the day', criteria: [{ key: 'change_pct', op: 'lte', value: -1 }] },
  { id: 'l3', group: 'Day move', label: 'Losers ≤ -3%', hint: 'Heavy decliners', criteria: [{ key: 'change_pct', op: 'lte', value: -3 }] },
  { id: 'gl', group: 'Day move', label: 'Gainers + liquid', hint: 'Day gain ≥1% and volume ≥1L', criteria: [{ key: 'change_pct', op: 'gte', value: 1 }, { key: 'volume', op: 'gte', value: 100000 }] },

  // ---- volume & liquidity ------------------------------------------------ #
  { id: 'v100k', group: 'Volume & liquidity', label: 'Volume ≥ 1 lakh', hint: 'Traded quantity floor', criteria: [{ key: 'volume', op: 'gte', value: 100000 }] },
  { id: 'v500k', group: 'Volume & liquidity', label: 'Volume ≥ 5 lakh', hint: 'Busy counters', criteria: [{ key: 'volume', op: 'gte', value: 500000 }] },
  { id: 'tv1cr', group: 'Volume & liquidity', label: 'Turnover ≥ ₹1 Cr', hint: 'Traded value floor', criteria: [{ key: 'traded_value', op: 'gte', value: 10000000 }] },
  { id: 'liquid', group: 'Volume & liquidity', label: 'Most liquid', hint: 'Volume ≥ 5L and turnover ≥ ₹1 Cr', criteria: [{ key: 'volume', op: 'gte', value: 500000 }, { key: 'traded_value', op: 'gte', value: 10000000 }] },

  // ---- price band -------------------------------------------------------- #
  { id: 'p800', group: 'Price band', label: 'Under ₹800', hint: 'Weekly screen price cap', criteria: [{ key: 'ltp', op: 'lte', value: 800 }] },
  { id: 'p500', group: 'Price band', label: 'Under ₹500', hint: 'Lower-priced universe', criteria: [{ key: 'ltp', op: 'lte', value: 500 }] },
  { id: 'p100-800', group: 'Price band', label: '₹100 – ₹800', hint: 'Mid price band', criteria: [{ key: 'ltp', op: 'between', value: [100, 800] }] },

  // ---- quality ----------------------------------------------------------- #
  { id: 'live', group: 'Quality', label: 'Live feed only', hint: 'Drop stale / pending rows', criteria: [{ key: 'freshness', op: 'in', value: ['LIVE'] }] },
  { id: 'gainers-only', group: 'Quality', label: 'Backend GAINER class', hint: 'Engine classification', criteria: [{ key: 'classification', op: 'in', value: ['GAINER'] }] },
  { id: 'near-circuit', group: 'Quality', label: 'Near circuit (≤2%)', hint: 'Closest valid circuit distance', criteria: [{ key: 'circuit_distance', op: 'lte', value: 2 }] },
  { id: 'leveraged', group: 'Quality', label: 'Margin ≥ 5x', hint: 'Broker-authoritative leverage', criteria: [{ key: 'margin_multiplier', op: 'gte', value: 5 }] },
];

function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

export default function FiltersTab({ onViewInRank }: {
  /**
   * Hands the backend-applied matches to the canonical Volume & Rank table so the
   * same rows can be inspected with the full sortable/virtualised table instead
   * of a second bespoke one.
   */
  onViewInRank?: (rows: MWRow[], total: number) => void;
}) {
  const [catalog, setCatalog] = useState<FilterCatalogEntry[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  // Builder working state
  const [key, setKey] = useState('');
  const [op, setOp] = useState('gte');
  const [single, setSingle] = useState('');
  const [lo, setLo] = useState('');
  const [hi, setHi] = useState('');
  const [enumVals, setEnumVals] = useState('');
  const [criteria, setCriteria] = useState<FilterCriterion[]>([]);

  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ApplyResponse | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const meta = useMemo(() => catalog.find((c) => c.key === key), [catalog, key]);
  const effectiveOp = op === 'between' ? 'between' : meta?.type === 'minimum' ? 'gte' : meta?.type === 'text' ? 'contains' : op;

  const fetchCatalog = useCallback(async () => {
    try {
      setConfigError(null);
      const res = await fetchJson<ConfigResponse>('/api/market-watch/config');
      setCatalog(res.filterCatalog ?? []);
    } catch (err: any) {
      setConfigError(err?.message ?? 'config unavailable');
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  const fetchSaved = useCallback(async () => {
    try {
      const res = await fetchJson<{ ok: boolean; filters: SavedFilter[] }>('/api/market-watch/filters');
      setSaved(res.filters ?? []);
    } catch {
      // saved filters are best-effort; builder still works
    }
  }, []);

  useEffect(() => {
    fetchCatalog();
    fetchSaved();
    // doc §29 — "avoid duplicate requests". The filter catalog is static engine
    // configuration and the saved-filter list only changes when this tab itself
    // saves or deletes one (both already refetch explicitly). Re-reading both
    // every 12s was pure traffic; the mount read is enough.
  }, [fetchCatalog, fetchSaved]);

  const onKeyChange = (k: string) => {
    setKey(k);
    const m = catalog.find((c) => c.key === k);
    if (m) {
      setOp(m.type === 'enum' ? 'in' : m.type === 'text' ? 'contains' : 'gte');
    }
  };

  const draftValid = useMemo(() => {
    if (!meta) return false;
    if (meta.type === 'range') {
      if (op === 'between') return num(lo) != null && num(hi) != null && num(hi)! >= num(lo)!;
      return num(single) != null;
    }
    if (meta.type === 'minimum') return num(single) != null;
    if (meta.type === 'enum') return enumVals.split(',').map((s) => s.trim()).filter(Boolean).length > 0;
    return single.trim().length > 0;
  }, [meta, op, single, lo, hi, enumVals]);

  const buildDraft = useCallback((): FilterCriterion | null => {
    if (!meta || !draftValid) return null;
    if (meta.type === 'range') {
      return { key, op: effectiveOp, value: op === 'between' ? [num(lo)!, num(hi)!] : num(single)! };
    }
    if (meta.type === 'minimum') {
      return { key, op: 'gte', value: num(single)! };
    }
    if (meta.type === 'enum') {
      return { key, op: op === 'neq' ? 'neq' : 'in', value: enumVals.split(',').map((s) => s.trim()).filter(Boolean) };
    }
    return { key, op: 'contains', value: single.trim() };
  }, [meta, draftValid, key, effectiveOp, op, single, lo, hi, enumVals]);

  const addDraft = useCallback(() => {
    const draft = buildDraft();
    if (!draft) return;
    setCriteria((c) => [...c, draft]);
    setActivePreset(null);
    setSingle(''); setLo(''); setHi(''); setEnumVals('');
  }, [buildDraft]);

  const applyCriteria = useCallback(async (criteriaToUse: FilterCriterion[], filterId?: string) => {
    setApplying(true);
    setError(null);
    setResult(null);
    try {
      const body = filterId ? { filterId } : { criteria: criteriaToUse, limit: 200 };
      const res = await fetchJson<ApplyResponse>('/api/market-watch/filters/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError('Backend rejected the filter');
        return;
      }
      setResult(res);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to apply filter');
    } finally {
      setApplying(false);
    }
  }, []);

  const applyPreset = useCallback((preset: Preset) => {
    setActivePreset(preset.id);
    setCriteria(preset.criteria);
    setNotice(`Preset “${preset.label}” applied through the backend.`);
    void applyCriteria(preset.criteria);
  }, [applyCriteria]);

  const saveFilter = useCallback(async () => {
    if (!name.trim() || criteria.length === 0) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetchJson<{ ok: boolean; reason?: string; filterId?: string }>('/api/market-watch/filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, criteria, limit: 200 }),
      });
      setNotice(res.ok ? 'Filter saved' : `Save failed: ${res.reason ?? 'unknown'}`);
      setName(''); setDescription('');
      await fetchSaved();
    } catch {
      setNotice('Save failed — backend unavailable');
    } finally {
      setSaving(false);
    }
  }, [name, description, criteria, fetchSaved]);

  const deleteSaved = useCallback(async (id: string) => {
    try {
      await fetchJson(`/api/market-watch/filters/${id}`, { method: 'DELETE' });
      await fetchSaved();
    } catch {
      setNotice('Delete failed — backend unavailable');
    }
  }, [fetchSaved]);

  const loadSavedDetail = useCallback(async (id: string) => {
    try {
      const res = await fetchJson<{ ok: boolean; filter: SavedFilterDetail }>(`/api/market-watch/filters/${id}`);
      if (res.ok && res.filter) {
        setCriteria(res.filter.criteria);
        setName(res.filter.name);
        setNotice(`Loaded "${res.filter.name}" into the builder.`);
        setResult(null);
      }
    } catch {
      setNotice('Could not load filter');
    }
  }, []);

  if (loadingCatalog) return <LoadingState text="Loading filter catalog…" />;

  return (
    <div className="space-y-4">
      {configError && <ErrorState message={configError} onRetry={fetchCatalog} />}
      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}
      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Predefined screens — one click fills the builder and runs the exact
          same backend apply call. */}
      <SectionCard
        title="Quick Presets"
        icon={Zap}
        headerRight={<Badge variant="outline" className="text-[10px]">backend-applied</Badge>}
      >
        <div className="space-y-3">
          {PRESET_GROUPS.map((group) => {
            const list = PRESETS.filter((p) => p.group === group);
            if (!list.length) return null;
            return (
              <div key={group}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group}</p>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((preset) => {
                    const active = activePreset === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        disabled={applying}
                        title={preset.hint}
                        className={
                          'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50 ' +
                          (active
                            ? 'border-primary bg-primary/10 font-medium text-primary'
                            : 'border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground')
                        }
                      >
                        {active ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          A preset is just a criteria list — applying it posts to <span className="font-mono">/filters/apply</span>.
          After applying you can add or remove criteria above to refine it, then save it for later.
        </p>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {/* Builder */}
        <SectionCard title="Filter Builder" icon={Filter}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Field</label>
                <Select value={key} onValueChange={onKeyChange}>
                  <SelectTrigger className="w-44"><SelectValue placeholder="Choose a field" /></SelectTrigger>
                  <SelectContent>
                    {catalog.map((c) => (
                      <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {meta?.type === 'range' && (
                <div className="flex items-end gap-2">
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Op</label>
                    <Select value={op} onValueChange={setOp}>
                      <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {RANGE_OPS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {op === 'between' ? (
                    <div className="flex items-center gap-1">
                      <Input inputMode="decimal" placeholder="min" value={lo} onChange={(e) => setLo(e.target.value)} className="w-24" />
                      <span className="text-xs text-muted-foreground">–</span>
                      <Input inputMode="decimal" placeholder="max" value={hi} onChange={(e) => setHi(e.target.value)} className="w-24" />
                    </div>
                  ) : (
                    <Input inputMode="decimal" placeholder="value" value={single} onChange={(e) => setSingle(e.target.value)} className="w-24" />
                  )}
                </div>
              )}
              {meta?.type === 'minimum' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Min value</label>
                  <Input inputMode="decimal" placeholder="0" value={single} onChange={(e) => setSingle(e.target.value)} className="w-28" />
                </div>
              )}
              {meta?.type === 'text' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Contains</label>
                  <Input placeholder="substring" value={single} onChange={(e) => setSingle(e.target.value)} className="w-40" />
                </div>
              )}
              {meta?.type === 'enum' && (
                <div className="space-y-1">
                  <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Ops</label>
                  <div className="flex items-center gap-2">
                    <Select value={op} onValueChange={setOp}>
                      <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ENUM_OPS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input placeholder={meta.options?.join(', ')} value={enumVals} onChange={(e) => setEnumVals(e.target.value)} className="w-40" />
                  </div>
                </div>
              )}
              <Button size="sm" onClick={addDraft} disabled={!draftValid}>
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>

            {/* Active criteria list */}
            {criteria.length ? (
              <div className="space-y-1.5">
                {criteria.map((c, i) => {
                  const m = catalog.find((x) => x.key === c.key);
                  const label = Array.isArray(c.value) ? c.value.join(' – ') : String(c.value);
                  return (
                    <div key={i} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                      <span className="font-medium">{m?.label ?? c.key} <Badge variant="outline" className="ml-1 font-mono text-[10px]">{c.op} {label}</Badge></span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        onClick={() => {
                          setCriteria((cs) => cs.filter((_, j) => j !== i));
                          setActivePreset(null);
                        }}
                        aria-label="Remove criterion"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No criteria yet — add at least one, then Apply to see matches.</p>
            )}

            {criteria.length > 0 && (
              <>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => applyCriteria(criteria)} disabled={applying}>
                    {applying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Apply
                  </Button>
                  <div className="ml-auto flex flex-1 gap-2 justify-end">
                    <Input placeholder="Filter name" value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
                    <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} className="w-48" />
                    <Button size="sm" variant="outline" onClick={saveFilter} disabled={saving || !name.trim()}>
                      <Save className="h-3.5 w-3.5" /> Save
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </SectionCard>

        {/* Saved filters */}
        <SectionCard title="Saved Filters" icon={ListFilter} headerRight={<Badge variant="outline">{saved.length}</Badge>}>
          {saved.length === 0 ? (
            <EmptyState icon={ListFilter} title="No saved filters" description="Save a builder result to reuse it later." />
          ) : (
            <div className="space-y-2">
              {saved.map((f) => (
                <div key={f.filterId} className="rounded-md border border-border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{f.name}</div>
                      {f.description && <div className="truncate text-[10px] text-muted-foreground">{f.description}</div>}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => applyCriteria([], f.filterId)}>
                        <Play className="h-3 w-3" /> Run
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => loadSavedDetail(f.filterId)}>Edit</Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deleteSaved(f.filterId)} aria-label="Delete filter">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Apply results — rendered with the SAME shared stock table the Movers and
          Volume & Rank tabs use, so there is no second table implementation. */}
      {applying ? (
        <LoadingState text="Applying filter…" />
      ) : result ? (
        <SectionCard
          title={`Matches (${result.total})`}
          icon={Filter}
          headerRight={
            <div className="flex items-center gap-2">
              <Badge variant="outline">{result.count} shown</Badge>
              {result.hasMore ? <Badge variant="outline">+{result.total - result.count} more</Badge> : null}
              {onViewInRank ? (
                <Button size="sm" variant="outline" onClick={() => onViewInRank(result.items, result.total)}>
                  <Rows3 className="h-3.5 w-3.5" /> View in Volume &amp; Rank
                </Button>
              ) : null}
            </div>
          }
        >
          {result.items.length === 0 ? (
            <EmptyState icon={Filter} title="No matches" description="No rows satisfied every criterion (rows lacking a field never fake a pass)." />
          ) : (
            <MwTableShell headerCells={['#', 'symbol', 'ltp', 'change %', '5m%', 'circuit', 'margin', 'class', 'volume', 'turnover', 'pinned', 'status']}>
              {result.items.map((s, i) => (
                <MwRowRow
                  key={s.token}
                  row={s}
                  index={i}
                  cols={{ momentum: true, circuit: true, classification: true, volume: true, turnover: true }}
                />
              ))}
            </MwTableShell>
          )}
          {result.hasMore ? (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {result.count} of {result.total} matches loaded — the backend applied the criteria server-side; no row was filtered in the browser.
            </p>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}