'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Database, Loader2, RefreshCw, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getStocks } from '@/lib/api';
import { cn } from '@/lib/utils';

export type DbStock = {
  symbol: string;
  companyName: string;
  instrumentToken: string;
  active: boolean;
  tickCountToday: number | null;
};

function toDbStock(s: any): DbStock | null {
  const symbol = String(s?.symbol ?? '').trim();
  if (!symbol) return null;
  const identity = s?.identity ?? {};
  const companyName =
    String(identity?.companyName ?? '').trim() && identity?.companyName !== 'Not available'
      ? String(identity.companyName)
      : symbol;
  const ticks = s?.tickStats?.tickCountToday;
  return {
    symbol,
    companyName,
    instrumentToken: String(s?.instrumentToken ?? ''),
    active: s?.active !== false,
    tickCountToday: typeof ticks === 'number' && Number.isFinite(ticks) ? ticks : null,
  };
}

/**
 * Stocks actually present in the DB (persisted subscriptions) with their real
 * company names + today's tick counts. One click toggles them into the export
 * selection — no typing needed when the data is already in the database.
 */
export default function DbStocks({
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onLoaded,
}: {
  selected: string[];
  onToggle: (symbol: string) => void;
  onSelectAll: (symbols: string[]) => void;
  onClear: () => void;
  onLoaded?: (symbols: Set<string>, count: number) => void;
}) {
  const [stocks, setStocks] = useState<DbStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getStocks();
      const list = (res?.data ?? res?.stocks ?? []) as any[];
      const parsed = list.map(toDbStock).filter((s): s is DbStock => s !== null);
      setStocks(parsed);
      onLoadedRef.current?.(new Set(parsed.map((s) => s.symbol)), parsed.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load DB stocks');
      setStocks([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...stocks].sort((a, b) => {
      // Selected first, then most ticks today, then A-Z.
      const sa = selectedSet.has(a.symbol) ? 0 : 1;
      const sb = selectedSet.has(b.symbol) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ta = a.tickCountToday ?? -1;
      const tb = b.tickCountToday ?? -1;
      if (ta !== tb) return tb - ta;
      return a.symbol.localeCompare(b.symbol);
    });
    if (!q) return sorted;
    return sorted.filter(
      (s) => s.symbol.toLowerCase().includes(q) || s.companyName.toLowerCase().includes(q),
    );
  }, [stocks, filter, selectedSet]);

  const withTicks = stocks.filter((s) => (s.tickCountToday ?? 0) > 0).length;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter DB stocks by name or symbol..."
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => onSelectAll(visible.map((s) => s.symbol))}
          disabled={visible.length === 0}
        >
          <Check className="mr-1 h-3 w-3" /> Select {visible.length > 0 ? `(${visible.length})` : ''}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onClear}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading stocks from database...
        </div>
      ) : error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[11px] text-destructive">
          {error}
        </p>
      ) : stocks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
          Database me koi subscribed stock nahi hai — search se instruments add karo.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">
            <span className="font-semibold text-foreground">{stocks.length}</span> stocks DB me
            {' · '}
            <span className="font-semibold text-teal-500">{withTicks}</span> me aaj ticks aaye
          </p>
          <div className="grid max-h-[260px] grid-cols-1 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2">
            {visible.map((s, i) => {
              const sel = selectedSet.has(s.symbol);
              const tints = [
                'hover:border-teal-500/50',
                'hover:border-sky-500/50',
                'hover:border-violet-500/50',
                'hover:border-amber-500/50',
                'hover:border-rose-500/50',
                'hover:border-emerald-500/50',
              ];
              return (
                <button
                  key={s.symbol}
                  type="button"
                  onClick={() => onToggle(s.symbol)}
                  title={`${s.companyName} — click to ${sel ? 'remove' : 'add'}`}
                  className={cn(
                    'group flex min-w-0 items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all',
                    sel
                      ? 'border-teal-500/60 bg-gradient-to-r from-teal-500/15 to-emerald-500/10 shadow-sm'
                      : 'border-border/70 bg-card hover:shadow-sm',
                    !sel && tints[i % tints.length],
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold',
                      sel
                        ? 'bg-gradient-to-br from-teal-500 to-emerald-500 text-white'
                        : 'bg-gradient-to-br from-slate-500/20 to-slate-500/5 text-foreground',
                    )}
                  >
                    {sel ? <Check className="h-4 w-4" /> : s.symbol.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold leading-tight">{s.companyName}</span>
                    <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">
                      {s.symbol}
                      {s.tickCountToday != null && s.tickCountToday > 0 && (
                        <span className="text-teal-500"> · {s.tickCountToday.toLocaleString('en-IN')} ticks today</span>
                      )}
                    </span>
                  </span>
                  <span
                    title={s.active ? 'Subscription active' : 'Subscription inactive'}
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      s.active ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]' : 'bg-muted-foreground/40',
                    )}
                  />
                </button>
              );
            })}
          </div>
          {visible.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
              &quot;{filter}&quot; se koi DB stock match nahi hua.
            </p>
          )}
        </>
      )}

      <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <Database className="h-3 w-3" />
        Persisted subscriptions (DB) — green dot = active. Search box upar wale se poora instrument master search hota hai.
      </p>
    </div>
  );
}
