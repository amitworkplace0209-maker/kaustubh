'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Filter, Plus, Trash2, Save, Play, ListFilter, RefreshCw, Rows3 } from 'lucide-react';
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
                      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))} aria-label="Remove criterion">
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
            <MwTableShell headerCells={['#', 'symbol', 'ltp', 'change %', 'volume', 'turnover', 'pinned', 'status']}>
              {result.items.map((s, i) => (
                <MwRowRow key={s.token} row={s} index={i} cols={{ volume: true, turnover: true }} />
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