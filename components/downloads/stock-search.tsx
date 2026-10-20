'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Check, Hash, Globe, Loader2, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import { SEARCH_SUGGESTION_LIMIT } from '@/lib/instrument-search';
import { cn } from '@/lib/utils';

type StockSearchPopoverProps = {
  selected: string[];
  onSelect: (symbols: string[]) => void;
  subscribedSymbols?: Set<string>;
  maxSelections?: number;
  placeholder?: string;
  disabled?: boolean;
};

export default function StockSearchPopover({
  selected,
  onSelect,
  subscribedSymbols,
  maxSelections = 200,
  placeholder = 'Search symbol, company name, token, or ISIN...',
  disabled = false,
}: StockSearchPopoverProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce, cancellation, stale-response guarding and caching are owned by the
  // shared hook. It passes a real AbortSignal to the search client, so the
  // previous local AbortController (which this call never honoured) is gone.
  const search = useInstrumentSearch(query, {
    limit: SEARCH_SUGGESTION_LIMIT,
    enabled: !disabled,
  });
  const results = search.results;
  const loading = search.status === 'debouncing' || search.status === 'loading';

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    if (results.length > 0) setActiveIndex(-1);
  }, [results]);

  const toggleSymbol = useCallback((symbol: string) => {
    const next = selectedSet.has(symbol)
      ? selected.filter((s) => s !== symbol)
      : selected.length < maxSelections
        ? [...selected, symbol]
        : selected;
    onSelect(next);
    // Clear the query after adding so the next instrument can be typed
    // immediately; the popover stays open for fast multi-add.
    if (!selectedSet.has(symbol) && next.length !== selected.length) setQuery('');
  }, [selected, selectedSet, maxSelections, onSelect]);

  const addAllVisible = useCallback(() => {
    const room = Math.max(0, maxSelections - selected.length);
    const fresh = results.map((r) => r.symbol).filter((s) => !selectedSet.has(s)).slice(0, room);
    if (fresh.length > 0) onSelect([...selected, ...fresh]);
    setQuery('');
  }, [results, selected, selectedSet, maxSelections, onSelect]);

  const removeSymbol = useCallback((symbol: string) => {
    onSelect(selected.filter((s) => s !== symbol));
  }, [selected, onSelect]);

  const clearAll = useCallback(() => {
    onSelect([]);
  }, [onSelect]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Highlighted result wins; otherwise the top result (fast keyboard add).
      const target = activeIndex >= 0 && activeIndex < results.length
        ? results[activeIndex]
        : results[0];
      if (target) toggleSymbol(target.symbol);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  }, [activeIndex, results, toggleSymbol]);

  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (disabled) {
      setOpen(false);
      return;
    }
    setOpen(next);
    if (!next) setActiveIndex(-1);
  }, [disabled]);

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <div
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-label="Stock search"
            tabIndex={disabled ? -1 : 0}
            onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus(); } }}
            className={cn(
              'flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-xl border-2 bg-background px-3 py-2 transition-all cursor-text',
              open
                ? 'border-teal-500/60 shadow-[0_0_0_3px_rgba(20,184,166,0.12)]'
                : 'border-input hover:border-teal-500/40',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {selected.length === 0 && (
              <Search className="h-4 w-4 shrink-0 text-teal-500" />
            )}
            {selected.map((symbol) => (
              <Badge
                key={symbol}
                variant="secondary"
                className="flex items-center gap-1 border-teal-500/30 bg-gradient-to-r from-teal-500/15 to-emerald-500/10 py-0.5 pl-2 pr-1 text-xs font-medium"
              >
                {symbol}
                <button
                  type="button"
                  aria-label={`Remove ${symbol}`}
                  onClick={(e) => { e.stopPropagation(); removeSymbol(symbol); }}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <input
              ref={inputRef}
              value={query}
              disabled={disabled}
              onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => { if (!disabled) setOpen(true); }}
              onKeyDown={handleKeyDown}
              placeholder={selected.length === 0 ? placeholder : 'Add more...'}
              aria-label="Search instruments"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-[120px]"
            />
            {selected.length > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); clearAll(); }}
                className="text-[10px] text-muted-foreground hover:text-destructive transition-colors whitespace-nowrap"
              >
                Clear all
              </button>
            )}
          </div>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[min(420px,calc(100vw-2rem))] p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {results.length > 0 && !loading && (
            <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5">
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {results.length} match{results.length !== 1 ? 'es' : ''}
              </span>
              <button
                type="button"
                onClick={addAllVisible}
                className="text-[10px] font-medium text-teal-500 hover:underline"
              >
                Add all listed
              </button>
            </div>
          )}
          <div ref={listRef} role="listbox" className="max-h-[300px] overflow-y-auto">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching instruments...
              </div>
            )}
            {search.status === 'error' && (
              <div className="px-3 py-4 text-center text-xs text-destructive">
                {search.error ?? 'Instrument search is unavailable.'}
              </div>
            )}
            {!loading && search.status !== 'error' && results.length === 0 && query.trim() && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                No instruments found for &quot;{query}&quot;
              </div>
            )}
            {!loading && !query.trim() && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                Type to search NSE instruments by symbol, name, token, or ISIN
              </div>
            )}
            {results.map((inst, i) => {
              const symbol = inst.symbol;
              const isSelected = selectedSet.has(symbol);
              const isSub = subscribedSymbols?.has(symbol);
              return (
                <button
                  key={`${inst.exchange}-${symbol}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => toggleSymbol(symbol)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                    i === activeIndex && 'bg-accent',
                    isSelected && 'bg-primary/5',
                  )}
                >
                  <span className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                  )}>
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-semibold">
                        {inst.name && inst.name !== 'Not available' ? inst.name : symbol}
                      </span>
                      {isSub && (
                        <span className="shrink-0 rounded bg-teal-500/15 px-1 py-0 text-[8px] font-bold text-teal-500">IN DB</span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {symbol}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                    {inst.exchange && (
                      <span className="flex items-center gap-0.5">
                        <Globe className="h-2.5 w-2.5" />
                        {inst.exchange}
                      </span>
                    )}
                    {inst.token && (
                      <span className="flex items-center gap-0.5">
                        <Hash className="h-2.5 w-2.5" />
                        {inst.token}
                      </span>
                    )}
                    {inst.isin && inst.isin !== 'Not available' && (
                      <span className="hidden sm:inline">{inst.isin}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {selected.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {selected.length} stock{selected.length !== 1 ? 's' : ''} selected
          {selected.length >= maxSelections && ` (max ${maxSelections})`}
        </p>
      )}
    </div>
  );
}
