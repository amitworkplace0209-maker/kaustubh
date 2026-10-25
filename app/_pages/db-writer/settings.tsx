'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check, Gauge, Keyboard, RefreshCw, RotateCcw, Search, TriangleAlert, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getSettings, getSettingsRuntime, resetSetting, updateSetting } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DbwIstClock, DbwPageTabs, fmtNum } from './dbw-shared';

/**
 * SERVICES → DB Writer → Settings — runtime settings EXPLORER.
 *
 * OWN connection (har page ka alag):
 *   GET /api/settings           (flat settings list, category-grouped)
 *   GET /api/settings/runtime   (LIVE_KEYS + runtime cache snapshot)
 *   PUT /api/settings/{key}     (sirf pipeline knobs — toggles Permissions page par)
 *   POST /api/settings/{key}/reset
 *
 * Unique feature: stored-value vs LIVE runtime-cache drift dikhata hai —
 * setting store me jo likha hai aur engine cache me jo chal raha hai.
 */

type SettingDoc = { value?: unknown; category?: string; description?: string; type?: string };

type RuntimePayload = { liveKeys?: string[]; snapshot?: Record<string, unknown> };

/** DB-Writer pipeline knobs (engine ConfigField keys; number type). */
const KNOBS = [
  { key: 'flush_interval_ms', label: 'Flush interval', hint: 'buffer → MongoDB flush ka interval', min: 100, max: 60000 },
  { key: 'buffer_size', label: 'Buffer capacity', hint: 'memory me sagne layak ticks', min: 100, max: 1000000 },
  { key: 'bulk_insert_size', label: 'Bulk insert', hint: 'ek batch me kitne ticks', min: 1, max: 100000 },
] as const;

function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return String(v);
}

export default function DbWriterSettingsPage() {
  const [docs, setDocs] = useState<Record<string, SettingDoc> | null>(null);
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [category, setCategory] = useState('data_saver');
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [a, b] = await Promise.all([
        getSettings(),
        getSettingsRuntime(),
      ]);
      const flat = (a?.settings ?? (a?.data as any)?.settings ?? null) as Record<string, SettingDoc> | null;
      setDocs(flat && typeof flat === 'object' ? flat : {});
      setRuntime({
        liveKeys: Array.isArray(b?.liveKeys) ? b.liveKeys : [],
        snapshot: b?.snapshot && typeof b?.snapshot === 'object' ? b.snapshot : {},
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const [, d] of Object.entries(docs ?? {})) {
      const c = d?.category ?? 'general';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([name, n]) => ({ name, n }));
  }, [docs]);

  const liveKeys = useMemo(() => new Set(runtime?.liveKeys ?? []), [runtime]);

  const rows = useMemo(() => {
    const all = Object.entries(docs ?? {}).filter(([, d]) => (d?.category ?? 'general') === category);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter(([k, d]) => k.toLowerCase().includes(q) || String(d?.description ?? '').toLowerCase().includes(q))
      : all;
    return filtered.sort((x, y) => x[0].localeCompare(y[0]));
  }, [docs, category, query]);

  const saveKnob = useCallback(async (key: string) => {
    const doc = docs?.[key];
    const raw = drafts[key] ?? renderValue(doc?.value);
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setNotice({ kind: 'err', text: `${key}: valid number do.` });
      return;
    }
    setBusyKey(key);
    setNotice(null);
    try {
      await updateSetting(key, n);
      setNotice({ kind: 'ok', text: `${key} = ${n} save — runtime cache next reconcile pe live.` });
      setDrafts((d) => ({ ...d, [key]: String(n) }));
      await load();
    } catch (e: unknown) {
      setNotice({ kind: 'err', text: `${key}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyKey(null);
    }
  }, [docs, drafts, load]);

  const resetKnob = useCallback(async (key: string) => {
    setBusyKey(`${key}:reset`);
    setNotice(null);
    try {
      await resetSetting(key);
      setNotice({ kind: 'ok', text: `${key} reset ho gaya (default wapas).` });
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      await load();
    } catch (e: unknown) {
      setNotice({ kind: 'err', text: `${key}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyKey(null);
    }
  }, [load]);

  return (
    <div className="space-y-4 pb-6">
      {/* HERO — violet/indigo explorer band (table-first look) */}
      <div className="rounded-2xl border border-violet-500/30 bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-xl">
            <Keyboard className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">DB Writer · Runtime Settings</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              settings store + runtime cache explorer · apna /api/settings connection
            </p>
          </div>
          <DbwPageTabs active="settings" />
          <DbwIstClock />
          <Button size="sm" onClick={() => void load()} disabled={busyKey != null} className="gap-1.5 bg-gradient-to-r from-violet-500 to-indigo-600 shadow-md">
            <RefreshCw className="h-3.5 w-3.5" /> Reload
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">{fmtNum(Object.keys(docs ?? {}).length)} settings</Badge>
          <Badge variant="outline" className="font-mono">{fmtNum(runtime?.liveKeys?.length)} LIVE keys</Badge>
          <Badge variant="outline" className="font-mono">{fmtNum(categories.length)} categories</Badge>
          <Badge variant="outline" className="font-mono">snapshot keys {fmtNum(Object.keys(runtime?.snapshot ?? {}).length)}</Badge>
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-700">
          Settings store: {err}
          <Button size="sm" variant="outline" className="ml-2" onClick={() => void load()}>Retry</Button>
        </div>
      )}
      {notice && (
        <div className={cn(
          'rounded-xl border px-4 py-2.5 text-xs',
          notice.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' : 'border-rose-500/30 bg-rose-500/10 text-rose-700',
        )}>
          {notice.text}
        </div>
      )}

      {/* PIPELINE KNOBS — settings page ka unique editable feature */}
      <Card className="overflow-hidden border-violet-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-violet-500/10 to-indigo-500/5 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 p-1.5 text-white shadow"><Gauge className="h-3.5 w-3.5" /></span>
            Pipeline knobs (editable) · tick-buffer tuning
            <Badge variant="outline" className="ml-auto font-mono text-[10px]">permission toggles Permissions page par</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 pt-3 sm:grid-cols-3">
          {KNOBS.map(({ key, label, hint, min, max }) => {
            const doc = docs?.[key];
            const stored = doc?.value;
            const live = (runtime?.snapshot ?? {})[key];
            const draft = drafts[key];
            const shown = draft ?? renderValue(stored);
            const numValue = Number(shown);
            const drift = live !== undefined && numValue !== Number(live) && Number.isFinite(numValue);
            return (
              <div key={key} className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold">{label}</p>
                  {liveKeys.has(key) && <Badge variant="outline" className="border-emerald-500/40 font-mono text-[9px] text-emerald-700">LIVE</Badge>}
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{key}</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Input
                    className="h-7 w-24 font-mono text-xs"
                    inputMode="numeric"
                    value={shown}
                    min={min}
                    max={max}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    aria-label={`${label} knob`}
                  />
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busyKey === key || (draft ?? '') === '' || Number.isNaN(numValue)} onClick={() => void saveKnob(key)}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={busyKey === `${key}:reset`} onClick={() => void resetKnob(key)}>
                    <RotateCcw className="h-3 w-3" /> Reset
                  </Button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
                <p className={cn('mt-0.5 font-mono text-[10px]', drift ? 'text-amber-700' : 'text-emerald-700')}>
                  runtime: {live !== undefined ? String(live) : '—'}{drift ? ' · drift hai, reconcile hone tak' : ' · matched'}
                </p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* EXPLORER — category chips + search + mono table */}
      <Card className="overflow-hidden border-violet-500/25 shadow-soft">
        <CardHeader className="bg-gradient-to-r from-emerald-500/10 to-teal-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 p-1.5 text-white shadow"><Search className="h-3.5 w-3.5" /></span>
            Settings explorer · stored value vs runtime cache
            <div className="ml-auto flex items-center gap-1.5">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="key/desc filter"
                className="h-7 w-40 text-xs"
                aria-label="Settings filter"
              />
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-3">
          <div className="flex flex-wrap gap-1.5">
            {categories.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => setCategory(c.name)}
                className={cn(
                  'rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors',
                  category === c.name
                    ? 'border-violet-500/50 bg-violet-500/10 text-violet-700'
                    : 'border-border/60 text-muted-foreground hover:text-foreground',
                )}
              >
                {c.name} <span className="text-[9px] text-muted-foreground">×{c.n}</span>
              </button>
            ))}
            {!categories.length && <span className="text-xs text-muted-foreground">Koi category nahi.</span>}
          </div>

          <div className="max-h-[26rem] overflow-auto rounded-xl border border-border/50">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="text-left text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5">Key</th>
                  <th className="px-2 py-1.5">Description</th>
                  <th className="px-2 py-1.5 text-right">Stored</th>
                  <th className="px-2 py-1.5 text-right">Runtime</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, d]) => {
                  const live = (runtime?.snapshot ?? {})[key];
                  const isLive = liveKeys.has(key);
                  const drift = isLive && live !== undefined && d?.value !== live;
                  return (
                    <tr key={key} className="border-t border-border/40">
                      <td className="px-2 py-1.5 font-mono">{key}</td>
                      <td className="max-w-[26rem] truncate px-2 py-1.5 text-muted-foreground" title={d?.description ?? ''}>{d?.description ?? '—'}</td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        <span className="inline-flex items-center gap-1">
                          {typeof d?.value === 'boolean'
                            ? (d?.value
                              ? <><Check className="h-3 w-3 text-emerald-600" aria-label="ON" /><span className="text-emerald-700">ON</span></>
                              : <><X className="h-3 w-3 text-rose-600" aria-label="OFF" /><span className="text-rose-700">OFF</span></>)
                            : renderValue(d?.value)}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono">
                        {isLive ? (
                          <span className="inline-flex items-center gap-1.5">
                            {drift && <TriangleAlert className="h-3 w-3 text-amber-600" aria-label="drift" />}
                            <span className={drift ? 'text-amber-700' : 'text-emerald-700'}>{live !== undefined ? String(live) : '—'}</span>
                            <Badge variant="outline" className="border-emerald-500/40 px-1 py-0 font-mono text-[8px] text-emerald-700">LIVE</Badge>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">static</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">
                    {docs ? 'Is category me kuch match nahi hua.' : 'Settings load ho rahe…'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-muted-foreground">
            LIVE isi ka matlab: key runtime cache se har SAVE/DROP decision pe re-read hoti hai (restart nahi chahiye).
            drift = store aur cache alag — agla reconcile pe sahi ho jayega, ya Reload dabao.
          </p>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Sab values seedha settings store aur runtime cache se — koi number yahan banaya nahi jata. Storage numbers ke
        liye Storage page, tick control ke liye Permissions page apne-apne connections use karte hain.
      </p>
    </div>
  );
}
