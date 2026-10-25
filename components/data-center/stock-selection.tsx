'use client';

// ---- Data Center stock selection ----
// Modes Custom / All Active / All · debounced search over symbol, company,
// exchange and token · tri-state select-all · chunked rendering (no
// thousands-of-DOM-nodes) · per-row latest tick from the shared SSE stream.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, Search, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { UseLatestTicksResult } from '@/hooks/use-latest-ticks';
import { TICK_STALE_MS, useNow } from '@/lib/data-center-status';

export type DcStock = {
  symbol: string;
  active: boolean;
  company_name?: string;
  instrumentToken?: string;
  exchangeSegment?: string;
};

export type StockMode = 'all' | 'custom' | 'all_active';

const CHUNK = 60;
const SEARCH_DEBOUNCE_MS = 200;

function fmtTime(iso: string): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '\u2014' : d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
}

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return 'N/A';
  return `\u20B9${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type RowProps = {
  stock: DcStock;
  selectable: boolean;
  checked: boolean;
  onToggle: (symbol: string) => void;
  ltpText: string | null;
  tickTs: string;
  nowMs: number;
};

const StockRow = function StockRow({ stock, selectable, checked, onToggle, ltpText, tickTs, nowMs }: RowProps) {
  const age = tickTs ? nowMs - new Date(tickTs).getTime() : null;
  const live = age != null && Number.isFinite(age) && age <= TICK_STALE_MS;

  return (
    <>
      {/* Desktop row */}
      <tr className={cn('hidden border-b last:border-0 transition-colors hover:bg-muted/40 md:table-row', checked && 'bg-primary/5')}>
        {selectable && (
          <td className="p-2.5">
            <input
              type="checkbox"
              readOnly
              checked={checked}
              onClick={() => onToggle(stock.symbol)}
              className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
              aria-label={`Select ${stock.symbol}`}
            />
          </td>
        )}
        <td className="p-2.5 font-mono text-sm font-semibold">{stock.symbol}</td>
        <td className="max-w-[180px] truncate p-2.5 text-sm text-muted-foreground lg:table-cell">{stock.company_name || '\u2014'}</td>
        <td className="p-2.5 text-xs text-muted-foreground">{stock.exchangeSegment || '\u2014'}</td>
        <td className="hidden p-2.5 font-mono text-xs text-muted-foreground xl:table-cell">{stock.instrumentToken ? `#${stock.instrumentToken}` : '\u2014'}</td>
        <td className="p-2.5">
          {stock.active ? (
            <Badge variant="outline" className="h-5 border-success/30 bg-success/10 px-1.5 py-0 text-[9px] font-bold tracking-wider text-success">SUBSCRIBED</Badge>
          ) : (
            <Badge variant="secondary" className="h-5 px-1.5 py-0 text-[9px] tracking-wider">OFF</Badge>
          )}
        </td>
        <td className={cn('p-2.5 text-right font-mono text-sm tabular-nums', ltpText == null && 'text-muted-foreground')}>
          {tickTs ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-success animate-pulse' : 'bg-warning')} />
              {fmtPrice(ltpText == null ? null : Number(ltpText))}
            </span>
          ) : (
            <span className="text-muted-foreground">N/A</span>
          )}
        </td>
        <td className="hidden p-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground xl:table-cell">
          {fmtTime(tickTs)}
        </td>
      </tr>
      {/* Mobile card */}
      <tr className={cn('border-b last:border-0 md:hidden', checked && 'bg-primary/5')}>
        <td colSpan={8} className="p-0">
          <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
            {selectable && (
              <input
                type="checkbox"
                readOnly
                checked={checked}
                onClick={(e) => { e.preventDefault(); onToggle(stock.symbol); }}
                className="h-4 w-4 shrink-0 rounded border-border accent-primary"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold">{stock.symbol}</span>
                {stock.active ? (
                  <Badge variant="outline" className="h-4 border-success/30 bg-success/10 px-1 py-0 text-[8px] font-bold text-success">SUB</Badge>
                ) : (
                  <Badge variant="secondary" className="h-4 px-1 py-0 text-[8px]">OFF</Badge>
                )}
                {stock.exchangeSegment && <span className="truncate text-[10px] text-muted-foreground">{stock.exchangeSegment}</span>}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {fmtPrice(ltpText == null ? null : Number(ltpText))} · {tickTs ? fmtTime(tickTs) : 'no live tick'}
                {stock.instrumentToken ? ` · #${stock.instrumentToken}` : ''}
              </div>
            </div>
          </label>
        </td>
      </tr>
    </>
  );
};

export default function StockSelection({
  stocks,
  loading,
  selectedStocks,
  onSelectionChange,
  mode,
  onModeChange,
  live,
}: {
  stocks: DcStock[];
  loading: boolean;
  selectedStocks: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  mode: StockMode;
  onModeChange: (m: StockMode) => void;
  /** Shared SSE stream state — owned by the page (ONE connection). */
  live: UseLatestTicksResult;
}) {
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(CHUNK);
  const headerCheckRef = useRef<HTMLInputElement>(null);
  const { latest, connected } = live;
  const nowMs = useNow(5_000);

  // Debounce search input (no heavy work per keystroke).
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(rawSearch.trim().toLowerCase());
      setVisibleCount(CHUNK);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rawSearch]);

  const pool = useMemo(
    () => (mode === 'all_active' ? stocks.filter((s) => s.active) : stocks),
    [stocks, mode],
  );

  const filtered = useMemo(() => {
    if (!search) return pool;
    return pool.filter((s) =>
      s.symbol.toLowerCase().includes(search) ||
      (s.company_name ?? '').toLowerCase().includes(search) ||
      (s.instrumentToken ?? '').toLowerCase().includes(search) ||
      (s.exchangeSegment ?? '').toLowerCase().includes(search),
    );
  }, [pool, search]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const selectedInPool = useMemo(
    () => pool.reduce((acc, s) => acc + (selectedStocks.has(s.symbol) ? 1 : 0), 0),
    [pool, selectedStocks],
  );

  // Tri-state select-all over the FILTERED set.
  const allVisibleSelected = filtered.length > 0 && filtered.every((s) => selectedStocks.has(s.symbol));
  const someVisibleSelected = filtered.some((s) => selectedStocks.has(s.symbol)) && !allVisibleSelected;
  useEffect(() => {
    if (headerCheckRef.current) headerCheckRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected, filtered, selectedStocks]);

  const toggleStock = (symbol: string) => {
    const next = new Set(selectedStocks);
    if (next.has(symbol)) next.delete(symbol);
    else next.add(symbol);
    onSelectionChange(next);
  };

  const toggleAllFiltered = () => {
    const next = new Set(selectedStocks);
    if (allVisibleSelected) filtered.forEach((s) => next.delete(s.symbol));
    else filtered.forEach((s) => next.add(s.symbol));
    onSelectionChange(next);
  };

  const effectiveCount =
    mode === 'all_active' ? pool.length : mode === 'all' ? stocks.length : selectedStocks.size;

  const selectionLabel =
    selectedInPool === 0 ? `0 selected`
      : allVisibleSelected && filtered.length === pool.length ? `All ${selectedInPool} selected`
        : `${selectedInPool} selected`;

  return (
    <Card className="shadow-soft">
      <CardContent className="px-4 py-3.5">
        {/* Header */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/25">
            <ListChecks className="h-3.5 w-3.5" />
          </span>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Stock Selection</h3>
          <Badge variant="outline" className="ml-auto h-5 border-border/50 bg-muted/40 px-1.5 py-0 font-mono text-[10px] tabular-nums">
            {selectionLabel} / {stocks.length} stocks
          </Badge>
        </div>

        {/* Controls */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={(v) => { if (v) { onModeChange(v as StockMode); setVisibleCount(CHUNK); } }}
            className="justify-start"
          >
            <ToggleGroupItem value="custom" className="h-7 text-xs">Custom</ToggleGroupItem>
            <ToggleGroupItem value="all_active" className="h-7 text-xs">
              All Active ({stocks.filter((s) => s.active).length})
            </ToggleGroupItem>
            <ToggleGroupItem value="all" className="h-7 text-xs">All ({stocks.length})</ToggleGroupItem>
          </ToggleGroup>

          <div className="relative ml-auto min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Symbol, company, exchange or token…"
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              className="h-8 pl-10 pr-8 text-xs"
            />
            {rawSearch && (
              <X className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 cursor-pointer text-muted-foreground" onClick={() => setRawSearch('')} />
            )}
          </div>
        </div>

        {/* Bulk actions */}
        {mode === 'custom' && (
          <div className="mb-3 flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 rounded-lg text-xs" onClick={toggleAllFiltered}>
              {allVisibleSelected ? 'Deselect shown' : 'Select All shown'}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onSelectionChange(new Set())}>
              Clear All
            </Button>
          </div>
        )}

        {/* Table */}
        <div className="max-h-[340px] overflow-auto rounded-xl border border-border/40">
          <table className="w-full min-w-[560px] md:min-w-0">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="hidden border-b bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground md:table-row">
                {mode === 'custom' && (
                  <th className="w-10 p-2.5">
                    <input
                      ref={headerCheckRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllFiltered}
                      className="h-4 w-4 cursor-pointer rounded border-border accent-primary"
                      aria-label="Select all shown"
                    />
                  </th>
                )}
                <th className="p-2.5 font-semibold">Symbol</th>
                <th className="hidden p-2.5 font-semibold lg:table-cell">Company</th>
                <th className="p-2.5 font-semibold">Exchange</th>
                <th className="hidden p-2.5 font-semibold xl:table-cell">Token</th>
                <th className="p-2.5 font-semibold">Status</th>
                <th className="p-2.5 text-right font-semibold">Latest Tick</th>
                <th className="hidden p-2.5 text-right font-semibold xl:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading && stocks.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={8} className="p-0"><div className="m-1.5 h-8 animate-pulse rounded-md bg-muted/50" /></td></tr>
                ))
              ) : visible.length === 0 ? (
                <tr><td colSpan={8} className="p-8 text-center text-sm text-muted-foreground">
                  {search ? `No stocks match “${rawSearch}”` : 'No stocks found'}
                </td></tr>
              ) : (
                visible.map((stock) => (
                  <StockRow
                    key={stock.symbol}
                    stock={stock}
                    selectable={mode === 'custom'}
                    checked={selectedStocks.has(stock.symbol)}
                    onToggle={toggleStock}
                    ltpText={latest.get(stock.symbol)?.ltp?.toString() ?? null}
                    tickTs={latest.get(stock.symbol)?.ts ?? ''}
                    nowMs={nowMs}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Chunked paging + stream state */}
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-success animate-pulse' : 'bg-warning')} />
            {connected ? 'Live ticks streaming' : 'Tick stream reconnecting…'}
          </span>
          {filtered.length > visibleCount && (
            <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setVisibleCount((c) => c + 120)}>
              Show more ({filtered.length - visibleCount} remaining)
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
