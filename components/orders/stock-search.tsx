'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, X, ArrowUp, ArrowDown, CornerDownLeft, Loader2, AlertCircle, Zap, ChevronDown, ChevronUp, TrendingUp, TrendingDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getQuote } from '@/lib/api';
import { subscribeTicks } from '@/lib/shared-sse';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import { SEARCH_MIN_CHARS, shouldSearch, type CanonicalInstrument } from '@/lib/instrument-search';
import { cn } from '@/lib/utils';

/**
 * The public selection shape. This IS the canonical Search Engine row — the
 * order ticket, the Kotak trade page and the calculator all consume it — with
 * the legacy `companyName` alias kept so existing callers keep compiling.
 */
export type StockResult = CanonicalInstrument & { companyName?: string };

export type SearchSide = 'BUY' | 'SELL';

/**
 * Live broker quote overlay. Every field is `number | null`: a value the feed
 * did not supply stays null and renders as a placeholder, never as 0.
 */
type LiveQuote = {
  ltp: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
};

type Props = {
  onSelect: (stock: StockResult, side: SearchSide) => void;
  disabled?: boolean;
};

const MAX_RECENT = 5;
const STORAGE_KEY = 'orders_recent_searches';
const QUOTE_LIMIT = 30;
const SEARCH_LIMIT = 20;

function loadRecent(): StockResult[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveRecent(list: StockResult[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Canonical row -> the selection shape handed to callers. */
function toStockResult(r: CanonicalInstrument): StockResult {
  return { ...r, companyName: r.name };
}

/** The trading terminal is equities only. */
function isEquity(r: CanonicalInstrument): boolean {
  const t = r.instrumentType?.toUpperCase();
  return t === 'EQ' || t === 'STK' || t === '' || t === undefined;
}

function formatExchange(ex?: string): string {
  if (!ex) return '—';
  return ex.replace('nse_', 'NSE ').replace('bse_', 'BSE ').replace('mcx_', 'MCX ').toUpperCase();
}

function num(val: unknown): number | null {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'string' && val !== '') { const n = parseFloat(val); return isNaN(n) ? null : n; }
  return null;
}

function formatINR(val: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
}

function formatVolume(val: number): string {
  if (val >= 10000000) return `${(val / 10000000).toFixed(2)}Cr`;
  if (val >= 100000) return `${(val / 100000).toFixed(2)}L`;
  if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(val);
}

function signedAmount(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '₹0.00';
  return `${v > 0 ? '+' : '-'}${formatINR(Math.abs(v))}`;
}

function signedPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export default function StockSearch({ onSelect, disabled }: Props) {
  const [query, setQuery] = useState('');
  const [quotes, setQuotes] = useState<Map<string, LiveQuote>>(new Map());
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [recent, setRecent] = useState<StockResult[]>([]);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce, abort/cancellation, stale-response guarding and the TTL cache are
  // owned by the shared hook — this component keeps no timers of its own.
  // withMargin=false: dropdown needs only symbol + live LTP. Per-row broker
  // margin makes each keystroke wait ~2-3s (8 serial margin API calls).
  const search = useInstrumentSearch(query, { limit: SEARCH_LIMIT, withMargin: false });
  const loading = search.status === 'debouncing' || search.status === 'loading';

  const results = useMemo<StockResult[]>(
    () => search.results.filter(isEquity).map(toStockResult),
    [search.results],
  );

  useEffect(() => { setRecent(loadRecent()); }, []);

  // Honest round-trip timing for the footer: measured from the moment the hook
  // starts loading to the moment results land. Nothing is invented when the
  // backend answered from cache (no loading phase -> no timing shown).
  const requestStartedAt = useRef<number>(0);
  useEffect(() => {
    if (search.status === 'debouncing') requestStartedAt.current = 0;
    if (search.status === 'loading') requestStartedAt.current = Date.now();
  }, [search.status]);
  useEffect(() => {
    if (search.status !== 'results' && search.status !== 'empty') return;
    setSearchTime(requestStartedAt.current > 0 ? Date.now() - requestStartedAt.current : null);
  }, [search.status, search.resolvedQuery]);

  const seedQuotesFromResults = useCallback((rows: StockResult[]) => {
    setQuotes((prev) => {
      const next = new Map(prev);
      for (const s of rows) {
        if (s.ltp == null) continue;
        next.set(String(s.token), {
          ltp: s.ltp,
          prevClose: s.prevClose ?? null,
          change: s.change ?? null,
          changePct: s.changePct ?? null,
          open: null,
          high: null,
          low: null,
          close: s.prevClose ?? null,
          volume: s.volume ?? null,
          upperCircuit: s.upperCircuit ?? null,
          lowerCircuit: s.lowerCircuit ?? null,
        });
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (results.length === 0) { setQuotes(new Map()); return; }
    // Seed canonical live state immediately so the card is never blank while
    // the broker REST quote / SSE tick arrives.
    seedQuotesFromResults(results);
    let cancelled = false;
    const tokens = results.slice(0, QUOTE_LIMIT).map((r) => ({ instrument_token: r.token, exchange_segment: r.exchange }));
    getQuote(tokens, 'ltp')
      .then((data) => {
        if (cancelled) return;
        const arr = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
        setQuotes((prev) => {
          const next = new Map(prev);
          for (const q of arr) {
            const tok = String(q?.instrument_token ?? q?.exchange_token ?? '');
            if (!tok) continue;
            const ltp = num(q?.ltp ?? q?.last_price);
            if (ltp == null || ltp <= 0) continue;
            const prevClose = num(q?.ohlc?.close ?? q?.close ?? q?.previous_close);
            const prior = next.get(tok);
            const change = prevClose != null && prevClose > 0 ? ltp - prevClose : (prior?.change ?? null);
            next.set(tok, {
              ltp,
              prevClose: prevClose ?? null,
              change,
              changePct: prevClose != null && prevClose > 0
                ? (change as number) / prevClose * 100
                : (prior?.changePct ?? null),
              open: num(q?.ohlc?.open ?? q?.open),
              high: num(q?.ohlc?.high ?? q?.high),
              low: num(q?.ohlc?.low ?? q?.low),
              close: num(q?.ohlc?.close ?? q?.close),
              volume: num(q?.volume ?? q?.vol ?? q?.total_traded_volume),
              upperCircuit: num(q?.upper_circuit ?? q?.upperCircuit),
              lowerCircuit: num(q?.lower_circuit ?? q?.lowerCircuit),
            });
          }
          return next;
        });
      })
      .catch(() => { /* keep canonical live state seeded from search */ });
    return () => { cancelled = true; };
  }, [results, seedQuotesFromResults]);

  useEffect(() => {
    if (!open || results.length === 0) return;
    const byToken = new Map(results.map((r) => [String(r.token), r]));
    const byTrd = new Map(results.map((r) => [(r.tradingSymbol || r.symbol || '').toUpperCase(), r]));
    // The dropdown rows follow the SHARED browser tick stream (one SSE session
    // for the whole app) — never its own EventSource.
    return subscribeTicks((t) => {
      try {
        const ltp = num(t.ltp);
        if (ltp == null || ltp <= 0) return;
        const tok = t.instrumentToken != null ? String(t.instrumentToken) : '';
        const trd = String(t.tradingSymbol ?? t.symbol ?? '').toUpperCase();
        const hit = (tok && byToken.get(tok)) || (trd && byTrd.get(trd));
        if (!hit) return;
        setQuotes(prev => {
          const cur = prev.get(String(hit.token));
          const prevClose = cur?.prevClose ?? null;
          const change = prevClose != null && prevClose > 0 ? ltp - prevClose : (cur?.change ?? null);
          const changePct = prevClose != null && prevClose > 0
            ? (change as number) / prevClose * 100
            : (cur?.changePct ?? null);
          const nextMap = new Map(prev);
          nextMap.set(String(hit.token), {
            ltp,
            prevClose,
            change,
            changePct,
            open: cur?.open ?? null,
            high: cur?.high != null && ltp > cur.high ? ltp : (cur?.high ?? null),
            low: cur?.low != null && ltp < cur.low ? ltp : (cur?.low ?? null),
            close: cur?.close ?? null,
            volume: cur?.volume ?? null,
            upperCircuit: cur?.upperCircuit ?? null,
            lowerCircuit: cur?.lowerCircuit ?? null,
          });
          return nextMap;
        });
      } catch { /* ignore */ }
    });
  }, [open, results]);

  const handleExplicitSearch = useCallback(() => {
    if (!shouldSearch(query, SEARCH_MIN_CHARS)) return;
    setSearchTime(null);
    search.refresh();
  }, [query, search]);

  const clearQuery = useCallback(() => {
    setQuery('');
    search.clear();
    setActiveIdx(-1);
    setOpen(false);
    setSearchTime(null);
    inputRef.current?.focus();
  }, [search]);

  const addRecent = useCallback((stock: StockResult) => {
    setRecent(prev => {
      const filtered = prev.filter(s => s.token !== stock.token);
      const next = [stock, ...filtered].slice(0, MAX_RECENT);
      saveRecent(next);
      return next;
    });
  }, []);

  const handleSelect = useCallback((stock: StockResult, side: SearchSide) => {
    addRecent(stock);
    setOpen(false); setQuery(''); search.clear(); setSearchTime(null);
    onSelect(stock, side);
    inputRef.current?.blur();
  }, [onSelect, addRecent, search]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = results;
    if (!open || items.length === 0) {
      if (e.key === 'Enter') { e.preventDefault(); handleExplicitSearch(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(prev => { const next = prev < items.length - 1 ? prev + 1 : 0; scrollActiveIntoView(next); return next; });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(prev => { const next = prev > 0 ? prev - 1 : items.length - 1; scrollActiveIntoView(next); return next; });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && activeIdx < items.length) handleSelect(items[activeIdx], 'BUY');
      else handleExplicitSearch();
    } else if (e.key === 'Escape') { setOpen(false); setActiveIdx(-1); }
  };

  const scrollActiveIntoView = (idx: number) => {
    const el = listRef.current?.querySelector(`[data-idx="${idx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };

  const handleFocus = () => { if (results.length > 0 || recent.length > 0) setOpen(true); };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-search-root]')) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const showDropdown = open && (results.length > 0 || search.error || loading || (query.length === 0 && recent.length > 0));

  return (
    <div className="space-y-4" data-search-root>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold tracking-tight">Trading Terminal</h2>
        </div>
        <p className="text-sm text-muted-foreground">Search equity stocks to begin trading</p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-2xl">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            placeholder="Search stock / symbol... (⌘K)"
            className="pl-11 pr-14 h-12 bg-card border-border/60 focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all text-base font-medium rounded-xl shadow-soft"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(-1); }}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {query && (
              <button
                className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
                onClick={clearQuery}
              >
                <X className="h-4 w-4" />
              </button>
            )}
            {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          </div>
        </div>
        <Button
          className="h-12 px-6 text-sm font-semibold rounded-xl shadow-soft"
          onClick={handleExplicitSearch}
          disabled={disabled || !shouldSearch(query, SEARCH_MIN_CHARS)}
        >
          <Search className="h-4 w-4 mr-2" /> Search
        </Button>
      </div>

      {showDropdown && (
        <div className="bg-card border border-border/60 rounded-xl shadow-soft-lg overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150 max-w-3xl">
          <div ref={listRef} className="max-h-[540px] overflow-y-auto p-2 space-y-1.5">
            {query.length === 0 && recent.length > 0 && (
              <>
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent Searches</span>
                  <button className="text-xs text-muted-foreground hover:text-foreground transition-colors font-medium" onClick={() => { setRecent([]); saveRecent([]); }}>Clear</button>
                </div>
                {recent.map((r, i) => (
                  <ResultCard
                    key={`recent-${r.token}`}
                    stock={r}
                    quote={quotes.get(r.token)}
                    active={activeIdx === i}
                    idx={i}
                    onSelect={handleSelect}
                    onMouseEnter={() => setActiveIdx(i)}
                    isRecent
                  />
                ))}
                <div className="px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Results</div>
              </>
            )}

            {loading && results.length === 0 && (
              <div className="space-y-1.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="rounded-xl border-l-[3px] border-l-muted border border-border/40 p-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                      <div className="h-3 w-14 bg-muted animate-pulse rounded" />
                      <div className="h-4 w-16 bg-muted animate-pulse rounded ml-auto" />
                    </div>
                    <div className="h-3 w-48 bg-muted animate-pulse rounded" />
                    <div className="flex items-end justify-between">
                      <div className="space-y-1">
                        <div className="h-6 w-28 bg-muted animate-pulse rounded" />
                        <div className="h-3 w-20 bg-muted animate-pulse rounded" />
                      </div>
                      <div className="flex gap-1.5">
                        <div className="h-7 w-14 bg-muted animate-pulse rounded-lg" />
                        <div className="h-7 w-14 bg-muted animate-pulse rounded-lg" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {search.error && (
              <div className="flex items-center gap-2.5 p-4 text-destructive text-sm">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{search.error}</span>
              </div>
            )}

            {results.map((r, i) => (
              <ResultCard
                key={r.token + r.exchange}
                stock={r}
                quote={quotes.get(r.token)}
                active={activeIdx === i}
                idx={i}
                onSelect={handleSelect}
                onMouseEnter={() => setActiveIdx(i)}
              />
            ))}

            {!loading && !search.error && search.status === 'empty' && (
              <div className="flex flex-col items-center py-10 text-center">
                <Search className="h-8 w-8 mb-3 text-muted-foreground/20" />
                <p className="text-sm font-medium text-muted-foreground">No equity stocks found</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Try a different symbol or company name</p>
              </div>
            )}

            {!loading && !search.error && query.length > 0 && !shouldSearch(query, SEARCH_MIN_CHARS) && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                Type at least {SEARCH_MIN_CHARS} characters to search.
              </div>
            )}
          </div>

          {(results.length > 0 || recent.length > 0) && (
            <div className="border-t border-border/30 px-4 py-2 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" /><ArrowDown className="h-3 w-3" /> Navigate</span>
              <span className="flex items-center gap-1"><CornerDownLeft className="h-3 w-3" /> Select BUY</span>
              <span>Esc</span>
              <span className="ml-auto flex items-center gap-2">
                {searchTime !== null && searchTime > 0 && (
                  <span className={`font-mono font-medium ${searchTime < 500 ? 'text-success' : 'text-warning'}`}>{searchTime}ms</span>
                )}
                <span>{results.length} result{results.length !== 1 ? 's' : ''}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {!open && !query && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-4">
            <Zap className="h-8 w-8 text-primary/30" />
          </div>
          <p className="text-lg text-muted-foreground font-medium">Search for a stock to start trading</p>
          <p className="text-sm text-muted-foreground/50 mt-1.5">Type a symbol like ONGC, TCS, or RELIANCE</p>
          <div className="flex items-center gap-2 mt-4">
            <kbd className="px-2 py-1 bg-muted/60 rounded-md text-[11px] font-mono text-muted-foreground border border-border/40">⌘K</kbd>
            <span className="text-xs text-muted-foreground/50">to focus search</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ stock: r, quote: q, active, idx, onSelect, onMouseEnter, isRecent }: {
  stock: StockResult;
  quote?: LiveQuote;
  active: boolean;
  idx: number;
  onSelect: (stock: StockResult, side: SearchSide) => void;
  onMouseEnter: () => void;
  isRecent?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevLtpRef = useRef<number | null>(null);

  const ltp = q?.ltp ?? null;
  const change = q?.change ?? null;
  const up = change != null && change > 0;
  const down = change != null && change < 0;
  // Authoritative 1-Qty MIS margin from the broker margin API (backend).
  // Never derived from LTP/leverage.
  const margin = r.marginStatus === 'AVAILABLE' && r.oneQtyMargin != null ? r.oneQtyMargin : null;
  const hasQuote = ltp != null && ltp > 0;

  useEffect(() => {
    const prev = prevLtpRef.current;
    if (prev === null || ltp === null) {
      prevLtpRef.current = ltp;
      return;
    }
    if (ltp !== prev && prev > 0) {
      const dir = ltp > prev ? 'up' : 'down';
      setFlash(dir);
      const t = setTimeout(() => setFlash(null), 500);
      prevLtpRef.current = ltp;
      return () => clearTimeout(t);
    }
    prevLtpRef.current = ltp;
  }, [ltp]);

  const cardBg = flash === 'up'
    ? 'bg-success/15'
    : flash === 'down'
      ? 'bg-destructive/15'
      : up
        ? 'bg-gradient-to-r from-success/[0.08] via-success/[0.03] to-transparent'
        : down
          ? 'bg-gradient-to-r from-destructive/[0.08] via-destructive/[0.03] to-transparent'
          : 'bg-gradient-to-r from-info/[0.05] via-info/[0.02] to-transparent';

  return (
    <div
      data-idx={idx}
      onClick={() => onSelect(r, 'BUY')}
      onMouseEnter={onMouseEnter}
      className={cn(
        'group relative cursor-pointer rounded-xl border border-l-[3px] px-3.5 py-3 transition-all duration-300',
        up
          ? 'border-l-success border-success/20 hover:border-success/40'
          : down
            ? 'border-l-destructive border-destructive/20 hover:border-destructive/40'
            : 'border-l-info border-border/50 hover:border-info/30',
        cardBg,
        active && 'ring-1 ring-primary/60 shadow-sm',
      )}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-sm font-bold truncate">{r.tradingSymbol || r.symbol}</span>
            <Badge
              variant="outline"
              className={cn(
                'text-[9px] font-mono px-1.5 py-0 h-4 shrink-0',
                r.exchangeSegment?.includes('nse')
                  ? 'border-success/30 text-success'
                  : r.exchangeSegment?.includes('bse')
                    ? 'border-info/30 text-info'
                    : 'border-warning/30 text-warning',
              )}
            >
              {formatExchange(r.exchangeSegment)}
            </Badge>
            {isRecent && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 shrink-0 border-warning/40 text-warning bg-warning/5">
                Recent
              </Badge>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
            {r.name || `${r.series || ''} ${r.instrumentType || ''}`.trim()}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="mt-0.5 p-1 rounded-md hover:bg-muted/60 transition-colors text-muted-foreground hover:text-foreground shrink-0"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      <div className="flex items-end justify-between gap-3 mt-2">
        <div className="min-w-0">
          {hasQuote && ltp != null ? (
            <>
              <div className={cn(
                'text-xl font-bold font-mono tabular-nums leading-none tracking-tight',
                up ? 'text-success' : down ? 'text-destructive' : 'text-foreground',
              )}>
                {formatINR(ltp)}
              </div>
              <div className={cn(
                'text-[11px] font-mono font-semibold tabular-nums mt-1',
                up ? 'text-success/80' : down ? 'text-destructive/80' : 'text-muted-foreground',
              )}>
                {signedAmount(change)}
                <span className="ml-1 opacity-70">{signedPct(q?.changePct ?? null)}</span>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">LTP unavailable</div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Volume</div>
          <div className="text-sm font-bold font-mono tabular-nums mt-0.5">
            {q?.volume != null && q.volume > 0 ? formatVolume(q.volume) : '—'}
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between gap-3 mt-2.5 pt-2.5 border-t border-border/20">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">1-Qty Margin (MIS)</div>
          <div className={cn(
            'mt-0.5 text-sm font-bold font-mono tabular-nums leading-tight',
            margin != null ? 'text-success' : 'text-muted-foreground',
          )}>
            {margin != null ? formatINR(margin) : (r.marginStatus === 'STALE' ? 'Stale' : '—')}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(r, 'BUY'); }}
            className="h-8 px-4 rounded-lg bg-success/15 border border-success/40 text-success text-[11px] font-bold tracking-wide hover:bg-success hover:text-white hover:shadow-md hover:shadow-success/25 active:scale-95 transition-all"
          >
            BUY
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onSelect(r, 'SELL'); }}
            className="h-8 px-4 rounded-lg bg-destructive/15 border border-destructive/40 text-destructive text-[11px] font-bold tracking-wide hover:bg-destructive hover:text-white hover:shadow-md hover:shadow-destructive/25 active:scale-95 transition-all"
          >
            SELL
          </button>
        </div>
      </div>

      {active && (r.liveStatus === 'STALE' || r.liveStatus === 'UNAVAILABLE' || margin == null) && (
        <div className="mt-2.5 p-2.5 bg-muted/30 rounded-lg border border-border/30 space-y-1.5 animate-in fade-in-0 duration-150">
          <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">Data Status</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
            <span>
              Live:{' '}
              <span className={cn(
                'font-semibold',
                r.liveStatus === 'LIVE' ? 'text-success' : r.liveStatus === 'STALE' ? 'text-warning' : 'text-destructive',
              )}>
                {r.liveStatus ?? 'UNAVAILABLE'}
              </span>
            </span>
            <span>
              Margin:{' '}
              <span className={cn(
                'font-semibold',
                margin != null ? 'text-success' : 'text-destructive',
              )}>
                {r.marginStatus ?? 'UNAVAILABLE'}
              </span>
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            Per-quantity margin is fetched from the broker when you preview the order.
          </p>
        </div>
      )}

      {expanded && hasQuote && (
        <div className="mt-2.5 p-2.5 bg-muted/20 rounded-lg border border-border/30 space-y-2.5 animate-in fade-in-0 slide-in-from-top-1 duration-150">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
            <TrendingUp className="h-3 w-3" />
            Market Data
          </div>
          <div className="grid grid-cols-5 gap-2 text-center">
            {([
              { label: 'Open', value: q?.open },
              { label: 'High', value: q?.high },
              { label: 'Low', value: q?.low },
              { label: 'Close', value: q?.close },
            ] as const).map(({ label, value }) => (
              <div key={label}>
                <div className="text-[9px] text-muted-foreground uppercase tracking-wider leading-none">{label}</div>
                <div className={cn(
                  'text-[11px] font-mono font-semibold tabular-nums mt-0.5',
                  label === 'High' ? 'text-success' : label === 'Low' ? 'text-destructive' : 'text-foreground',
                )}>
                  {value ? formatINR(value) : '—'}
                </div>
              </div>
            ))}
            <div>
              <div className="text-[9px] text-muted-foreground uppercase tracking-wider leading-none">Volume</div>
              <div className="text-[11px] font-mono font-semibold tabular-nums mt-0.5">
                {q?.volume ? formatVolume(q.volume) : '—'}
              </div>
            </div>
          </div>

          {(q?.upperCircuit || q?.lowerCircuit) ? (
            <div className="flex items-center justify-between text-[10px] pt-1 border-t border-border/20">
              <div className="flex items-center gap-1.5">
                <TrendingUp className="h-3 w-3 text-success" />
                <span className="text-muted-foreground">Upper Circuit</span>
                <span className="font-mono font-semibold text-success">{q?.upperCircuit ? formatINR(q.upperCircuit) : '—'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <TrendingDown className="h-3 w-3 text-destructive" />
                <span className="text-muted-foreground">Lower Circuit</span>
                <span className="font-mono font-semibold text-destructive">{q?.lowerCircuit ? formatINR(q.lowerCircuit) : '—'}</span>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground pt-1 border-t border-border/20">
            <span>Type: <span className="font-semibold text-foreground">{r.instrumentType || '—'}</span></span>
            <span>Series: <span className="font-semibold text-foreground">{r.series || '—'}</span></span>
            <span>Segment: <span className="font-semibold text-foreground">{formatExchange(r.exchangeSegment)}</span></span>
            <span>Token: <span className="font-mono font-semibold text-foreground">{r.token}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}
