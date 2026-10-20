'use client';

import { memo, useCallback, useEffect, useId, useState } from 'react';
import { Check, Loader2, Search, SearchX, X, Zap, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { changeTone, sign } from '@/components/design-system';
import type { OrderSide } from '@/components/orders/trade/types';
import { nextSuggestionIndex } from '@/lib/order-workspace';
import { SEARCH_MIN_CHARS, SEARCH_SUGGESTION_LIMIT, shouldSearch, type CanonicalInstrument } from '@/lib/instrument-search';
import type { InstrumentSelection } from '@/components/orders/trade/types';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';

function toSelection(r: CanonicalInstrument): InstrumentSelection {
  return {
    symbol: r.symbol || r.tradingSymbol, token: r.token, exchange: r.exchange,
    exchangeSegment: r.exchangeSegment, tradingSymbol: r.tradingSymbol,
    companyName: r.name, isin: r.isin, instrumentType: r.instrumentType,
    lotSize: r.lotSize ?? undefined, tickSize: r.tickSize ?? undefined,
    ltp: r.ltp, prevClose: r.prevClose, change: r.change, changePct: r.changePct,
    upperCircuit: r.upperCircuit, lowerCircuit: r.lowerCircuit,
    oneQtyMargin: r.oneQtyMargin, marginStatus: r.marginStatus,
    liveStatus: r.liveStatus, tickAgeSeconds: r.tickAgeSeconds,
    source: r.source ?? undefined, asOf: r.timestamp ?? undefined,
  };
}

function fmtPrice(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '—';
  return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtExchange(ex?: string): string {
  if (!ex) return 'NSE';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').trim().toUpperCase();
}

function fmtLot(inst: CanonicalInstrument): number | null {
  return inst.lotSize != null && Number.isFinite(inst.lotSize) && inst.lotSize >= 1 ? inst.lotSize : null;
}

function LiveBadge({ status }: { status?: string }) {
  const s = String(status ?? '').toUpperCase();
  if (s === 'LIVE') return <span className="rounded border border-success/30 bg-success/10 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-success">Live</span>;
  if (s === 'STALE') return <span className="rounded border border-warning/30 bg-warning/10 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-warning">Stale</span>;
  return <span className="rounded border border-border bg-muted/40 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">No quote</span>;
}

export type QuickPick = { symbol: string; token: string; ltp: number | null; changePct: number | null };

function InstrumentSearchBase({
  onSelect, selectedSymbol, disabled, selectedSelection, onClear,
}: { onSelect: (selection: InstrumentSelection, side?: OrderSide) => void; selectedSymbol?: string; disabled?: boolean; selectedSelection?: InstrumentSelection | null; onClear?: () => void }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const listId = useId();

  const search = useInstrumentSearch(query, { limit: SEARCH_SUGGESTION_LIMIT, withMargin: false });
  const results = search.results;
  const busy = search.status === 'debouncing' || search.status === 'loading';

  useEffect(() => {
    if (query === '') { setOpen(false); return; }
    if (results.length > 0 || busy) setOpen(true);
  }, [query, results.length, busy]);

  const clearQuery = () => { search.clear(); setQuery(''); setActiveIndex(-1); setOpen(false); };

  const commit = useCallback((index: number, side?: OrderSide) => {
    const hit = results[index];
    if (!hit) return;
    setOpen(false); setActiveIndex(-1); setQuery(''); search.clear();
    onSelect(toSelection(hit), side);
  }, [onSelect, results, search]);

  const ltpFor = (r: CanonicalInstrument): number | null => r.ltp;

  return (
    <section className="relative">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input type="search" inputMode="search" autoComplete="off" placeholder={selectedSymbol ? `Search another — ${selectedSymbol} selected` : 'Search stock (RELIANCE, TCS, INFY…)'} value={query} disabled={disabled}
            onChange={e => { setQuery(e.target.value); setActiveIndex(-1); }}
            onFocus={() => { if (results.length > 0 || busy) setOpen(true); }}
            onBlur={() => { setTimeout(() => setOpen(false), 120); }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (results.length === 0) return; setOpen(true); setActiveIndex(i => nextSuggestionIndex(i, results.length, e.key === 'ArrowDown' ? 'down' : 'up')); }
              else if (e.key === 'Enter') { if (open && activeIndex >= 0 && activeIndex < results.length) { e.preventDefault(); commit(activeIndex); } }
              else if (e.key === 'Escape') { setOpen(false); setActiveIndex(-1); }
            }}
            role="combobox" aria-expanded={open && results.length > 0} aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
            aria-autocomplete="list"
            className={cn('h-9 w-full rounded-lg border border-border bg-card pl-8 pr-8 text-[13px] font-semibold shadow-sm', 'outline-none transition-colors placeholder:font-normal placeholder:text-muted-foreground/70', 'focus:border-primary/60 focus:ring-2 focus:ring-primary/20 disabled:opacity-60', selectedSymbol && 'border-primary/40')}
            aria-label="Instrument search" />
          {query !== '' && <button type="button" onClick={clearQuery} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><X className="h-3 w-3" /></button>}
        </div>
        {selectedSelection && onClear && <button type="button" onClick={onClear} aria-label="Clear selection" className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"><X className="h-3 w-3" /> Clear</button>}
      </div>

      {query !== '' && !shouldSearch(query, SEARCH_MIN_CHARS) && <p className="mt-1 px-0.5 text-[10px] text-muted-foreground/70">Type at least {SEARCH_MIN_CHARS} characters.</p>}

      {open && busy && <div className="absolute left-0 right-0 top-full z-30 mt-1 flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-[11px] text-muted-foreground shadow-lg"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…</div>}

      {open && (search.status === 'results' || search.status === 'empty') && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-card shadow-xl">
          {results.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground"><SearchX className="h-3.5 w-3.5" /> No match for &ldquo;{query}&rdquo;</div>
          ) : (
            <ul id={listId} role="listbox" aria-label="Instrument suggestions" className="max-h-[46vh] divide-y divide-border/50 overflow-y-auto overscroll-contain">
              {results.map((r, i) => {
                const symbol = r.symbol || r.tradingSymbol;
                const name = r.name;
                const ltp = ltpFor(r);
                const chg = r.changePct;
                const exchange = fmtExchange(r.exchangeSegment || r.exchange);
                const lot = fmtLot(r);
                const margin = r.oneQtyMargin;
                const isSelected = selectedSymbol === symbol;
                return (
                  <li key={`${symbol}-${i}`}>
                    <button id={`${listId}-opt-${i}`} type="button" role="option" aria-selected={isSelected || activeIndex === i} onClick={() => commit(i)} onMouseMove={() => { if (activeIndex !== i) setActiveIndex(i); }}
                      className={cn('flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors', 'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none', isSelected && 'bg-primary/[0.07]', activeIndex === i && 'bg-muted/60')}>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          {isSelected && <Check className="h-3 w-3 shrink-0 text-primary" />}
                          <span className={cn('truncate text-[13px] font-bold', isSelected && 'text-primary')}>{symbol}</span>
                          <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{exchange}</span>
                          <LiveBadge status={r.liveStatus} />
                          {lot != null && <span className="hidden items-center gap-0.5 rounded-full border border-border bg-muted/30 px-1 py-px text-[9px] font-semibold text-muted-foreground sm:inline-flex"><Layers className="h-2 w-2" /> {lot}</span>}
                          {margin != null && Number.isFinite(margin) && <span className="hidden items-center gap-0.5 rounded-full border border-info/25 bg-info/5 px-1 py-px text-[9px] font-semibold text-info sm:inline-flex"><Zap className="h-2 w-2" /> {margin.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>}
                        </span>
                        {name && <span className="mt-0.5 block truncate pl-0.5 text-[10px] text-muted-foreground">{name}</span>}
                      </span>
                      <span className="shrink-0 text-right"><span className="block font-mono text-[13px] font-bold tabular-nums">₹{fmtPrice(ltp)}</span>{chg != null && <span className={cn('block font-mono text-[10px] tabular-nums', changeTone(chg))}>{sign(chg)}{chg.toFixed(2)}%</span>}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {search.status === 'error' && <div className="mt-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">Search unavailable: {search.error}</div>}
    </section>
  );
}

export const InstrumentSearch = memo(InstrumentSearchBase);