'use client';

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Layers, Loader2, Search, SearchX, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { changeTone, sign } from '@/components/design-system';
import { nextSuggestionIndex } from '@/lib/order-workspace';
import {
  SEARCH_MIN_CHARS,
  SEARCH_SUGGESTION_LIMIT,
  shouldSearch,
  type CanonicalInstrument,
} from '@/lib/instrument-search';
import type { InstrumentSelection, OrderSide } from '@/components/orders/trade/types';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';

export interface InstrumentSearchProps {
  onSelect: (selection: InstrumentSelection, side?: OrderSide) => void;
  selectedSymbol?: string;
  selectedSelection?: InstrumentSelection | null;
  onClear?: () => void;
  disabled?: boolean;
}

export type QuickPick = { symbol: string; token: string; ltp: number | null; changePct: number | null };

/**
 * The order page's per-request search ceiling.
 *
 * The shared default (8 s) is right for a warm backend, but the ORDER page is
 * the first surface an operator touches after a backend restart — and the first
 * query then has to build the search index, which takes longer than the
 * default allows. The page shows "Searching…" for the whole wait, so a longer
 * ceiling stays honest; the shared default is unchanged for every other page.
 */
const SEARCH_MAX_WAIT_MS_ORDER = 15_000;

function toSelection(r: CanonicalInstrument): InstrumentSelection {
  return {
    symbol: r.symbol || r.tradingSymbol,
    token: r.token,
    exchange: r.exchange,
    exchangeSegment: r.exchangeSegment,
    tradingSymbol: r.tradingSymbol,
    companyName: r.name,
    isin: r.isin,
    instrumentType: r.instrumentType,
    lotSize: r.lotSize ?? undefined,
    tickSize: r.tickSize ?? undefined,
    ltp: r.ltp,
    prevClose: r.prevClose,
    change: r.change,
    changePct: r.changePct,
    upperCircuit: r.upperCircuit,
    lowerCircuit: r.lowerCircuit,
    oneQtyMargin: r.oneQtyMargin,
    marginStatus: r.marginStatus,
    liveStatus: r.liveStatus,
    tickAgeSeconds: r.tickAgeSeconds,
    source: r.source ?? undefined,
    asOf: r.timestamp ?? undefined,
  };
}

function fmtPrice(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '—';
  return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtExchange(ex?: string): string {
  if (!ex) return 'NSE';
  return ex
    .replace('nse_', 'NSE ')
    .replace('bse_', 'BSE ')
    .replace('mcx_', 'MCX ')
    .trim()
    .toUpperCase();
}

function LiveBadge({ status }: { status?: string }) {
  const s = String(status ?? '').toUpperCase();
  if (s === 'LIVE') {
    return (
      <span className="rounded border border-success/30 bg-success/10 px-1 py-px text-[10px] font-bold uppercase tracking-wider text-success">
        Live
      </span>
    );
  }
  if (s === 'STALE') {
    return (
      <span className="rounded border border-warning/30 bg-warning/10 px-1 py-px text-[10px] font-bold uppercase tracking-wider text-warning">
        Stale
      </span>
    );
  }
  return (
    <span className="rounded border border-border bg-muted/40 px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      No quote
    </span>
  );
}

function InstrumentSearchBase({
  onSelect,
  selectedSymbol,
  disabled,
  selectedSelection,
  onClear,
}: InstrumentSearchProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const listId = useId();

  // The order page must not show a dead "Search unavailable" because the
  // backend's search index was still warming up (a cold backend answers the
  // first query in seconds, not milliseconds). Two things make it resilient:
  // a more forgiving per-request ceiling, and ONE automatic retry when the
  // request was aborted by that ceiling.
  const search = useInstrumentSearch(query, {
    limit: SEARCH_SUGGESTION_LIMIT,
    withMargin: false,
    maxWaitMs: SEARCH_MAX_WAIT_MS_ORDER,
  });
  const results = search.results;
  const busy = search.status === 'debouncing' || search.status === 'loading';
  const { refresh } = search;

  const retryRef = useRef<{ query: string; count: number }>({ query: '', count: 0 });
  useEffect(() => {
    if (search.status !== 'error') return;
    if (!/timed out/i.test(search.error ?? '')) return;
    if (retryRef.current.query !== query) retryRef.current = { query, count: 0 };
    if (retryRef.current.count >= 1) return;
    retryRef.current.count += 1;
    const timer = setTimeout(() => refresh(), 500);
    return () => clearTimeout(timer);
  }, [search.status, search.error, query, refresh]);

  useEffect(() => {
    if (query === '') {
      setOpen(false);
      return;
    }
    if (results.length > 0 || busy) setOpen(true);
  }, [query, results.length, busy]);

  const clearQuery = () => {
    search.clear();
    setQuery('');
    setActiveIndex(-1);
    setOpen(false);
  };

  const commit = useCallback(
    (index: number, side?: OrderSide) => {
      const hit = results[index];
      if (!hit) return;
      setOpen(false);
      setActiveIndex(-1);
      setQuery('');
      search.clear();
      onSelect(toSelection(hit), side);
    },
    [onSelect, results, search],
  );

  return (
    <section className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            inputMode="search"
            autoComplete="off"
            placeholder={selectedSymbol ? `Search another — ${selectedSymbol} selected` : 'Search stock (RELIANCE, TCS, INFY…)'}
            value={query}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(-1);
            }}
            onFocus={() => {
              if (results.length > 0 || busy) setOpen(true);
            }}
            onBlur={() => {
              setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (results.length === 0) return;
                setOpen(true);
                setActiveIndex((i) =>
                  nextSuggestionIndex(i, results.length, e.key === 'ArrowDown' ? 'down' : 'up'),
                );
              } else if (e.key === 'Enter') {
                if (open && activeIndex >= 0 && activeIndex < results.length) {
                  e.preventDefault();
                  commit(activeIndex);
                }
              } else if (e.key === 'Escape') {
                setOpen(false);
                setActiveIndex(-1);
              }
            }}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
            aria-autocomplete="list"
            className={cn(
              'h-11 w-full rounded-xl border border-border bg-card pl-9 pr-9 text-[14px] font-semibold shadow-sm',
              'outline-none transition-colors placeholder:font-normal placeholder:text-muted-foreground/70',
              'focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60',
              selectedSymbol && 'border-primary/40',
            )}
            aria-label="Instrument search"
          />
          {query !== '' && (
            <button
              type="button"
              onClick={clearQuery}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {selectedSelection && onClear && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            className="flex h-11 shrink-0 items-center gap-1 rounded-xl border border-border bg-card px-3 text-[11px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {query !== '' && !shouldSearch(query, SEARCH_MIN_CHARS) && (
        <p className="mt-1.5 px-1 text-[12px] text-muted-foreground/80">
          Type at least {SEARCH_MIN_CHARS} characters.
        </p>
      )}

      {open && busy && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-[12px] text-muted-foreground shadow-xl">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
        </div>
      )}

      {open && (search.status === 'results' || search.status === 'empty') && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          {results.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground">
              <SearchX className="h-3.5 w-3.5" /> No match for &ldquo;{query}&rdquo;
            </div>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label="Instrument suggestions"
              className="max-h-[46vh] divide-y divide-border/50 overflow-y-auto overscroll-contain"
            >
              {results.map((r, i) => {
                const symbol = r.symbol || r.tradingSymbol;
                const isSelected = selectedSymbol === symbol;
                return (
                  <li key={`${symbol}-${i}`}>
                    <div
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={isSelected || activeIndex === i}
                      onMouseMove={() => {
                        if (activeIndex !== i) setActiveIndex(i);
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left transition-colors',
                        'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none',
                        isSelected && 'bg-primary/[0.07]',
                        activeIndex === i && 'bg-muted/60',
                      )}
                      onClick={() => commit(i)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          {isSelected && <Check className="h-3 w-3 shrink-0 text-primary" />}
                          <span className={cn('truncate text-[14px] font-bold', isSelected && 'text-primary')}>
                            {symbol}
                          </span>
                          <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {fmtExchange(r.exchangeSegment || r.exchange)}
                          </span>
                          <LiveBadge status={r.liveStatus} />
                          {r.lotSize != null && Number.isFinite(r.lotSize) && r.lotSize >= 1 && (
                            <span className="hidden items-center gap-0.5 rounded-full border border-border bg-muted/30 px-1 py-px text-[10px] font-semibold text-muted-foreground sm:inline-flex">
                              <Layers className="h-2.5 w-2.5" /> {r.lotSize}
                            </span>
                          )}
                          {r.oneQtyMargin != null && Number.isFinite(r.oneQtyMargin) && (
                            <span className="hidden items-center gap-0.5 rounded-full border border-info/25 bg-info/5 px-1 py-px text-[10px] font-semibold text-info sm:inline-flex">
                              <Zap className="h-2.5 w-2.5" />
                              {r.oneQtyMargin.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </span>
                          )}
                        </span>
                        {r.name && (
                          <span className="mt-0.5 block truncate pl-0.5 text-[12px] text-muted-foreground">
                            {r.name}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-[14px] font-bold tabular-nums">
                          ₹{fmtPrice(r.ltp)}
                        </span>
                        {r.changePct != null && (
                          <span className={cn('block font-mono text-[11px] tabular-nums', changeTone(r.changePct))}>
                            {sign(r.changePct)}
                            {r.changePct.toFixed(2)}%
                          </span>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {search.status === 'error' && (
        <div className="mt-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {/timed out/i.test(search.error ?? '')
            ? 'The search service is slow to answer. It has been retried automatically — try again in a moment.'
            : `Search unavailable: ${search.error}`}
        </div>
      )}
    </section>
  );
}

export const InstrumentSearch = memo(InstrumentSearchBase);
