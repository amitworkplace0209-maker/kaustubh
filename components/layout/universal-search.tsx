'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from '@/components/ui/command';
import { ArrowRight, Clock, RefreshCw, Loader2, ScanSearch, SearchX } from 'lucide-react';
import { postDataQuality } from '@/lib/api';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import { SEARCH_MIN_CHARS, SEARCH_SUGGESTION_LIMIT, shouldSearch, type CanonicalInstrument } from '@/lib/instrument-search';
import { KAUSTUBH_APPS } from '@/lib/apps';
import { getAppByRoute, getSearchIndex } from '@/lib/navigation/registry';
import { rankSearchResults } from '@/lib/topbar/context-registry';
import { setPendingSymbol } from '@/lib/pending-symbol';
import { useSystem } from '@/components/system-provider';
import { cn } from '@/lib/utils';

interface SearchableItem {
  id: string;
  href: string;
  label: string;
  icon: React.ElementType;
  keywords: string[];
  phase: string;
  phaseLabel: string;
  badge?: string;
}

const ALL_NAV_ITEMS: SearchableItem[] = getSearchIndex().map((item) => ({
  id: item.id,
  href: item.href,
  label: item.label,
  icon: item.icon ?? ArrowRight,
  keywords: item.keywords,
  phase: item.app,
  phaseLabel: item.appName,
  badge: item.badge,
}));

/** Where a picked instrument lands: the live Market Watch terminal, which owns
 *  the symbol-detail view. The pick is handed over through `lib/pending-symbol`
 *  (NOT a query parameter) because no page reads one — see that module. */
const INSTRUMENT_DESTINATION = '/trading/market-watch';

const RECENT_KEY = 'kaustubh:recent-pages';

type Recent = { href: string; at: number };

function readRecents(): Recent[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Recent[];
    return Array.isArray(arr) ? arr.slice(0, 6) : [];
  } catch {
    return [];
  }
}

function labelFor(href: string): string {
  const known = ALL_NAV_ITEMS.find((i) => i.href === href);
  if (known) return known.label;
  const seg = href.split('/').filter(Boolean).pop();
  return (seg ?? href).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtPrice(v: unknown): string | null {
  const num = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(num)) return null;
  return num.toFixed(2);
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-IN');
}

/**
 * UniversalSearch — ONE palette for pages, instruments and actions across every
 * KAUSTUBH phase.
 *
 * Empty query  → Recent · Quick actions · Phase jump.
 * Typed query  → Stocks & Instruments (canonical Search Engine, live LTP) then
 *                pages grouped by phase, with the ACTIVE phase ranked first.
 *
 * Honest empty states: a typed query that matches no instrument says so
 * explicitly instead of silently showing only page hits, and a Search Engine
 * error is surfaced as a line rather than swallowed.
 */
export function UniversalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const activePhase = getAppByRoute(pathname);
  const { refresh } = useSystem();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);

  // Instrument half of the palette: the shared Search Engine hook owns the
  // debounce, cancellation, stale-response guard and cache. Live prices come
  // from the canonical row's `ltp` — no second quote round-trip, no local timer.
  const stockSearch = useInstrumentSearch(query, { limit: SEARCH_SUGGESTION_LIMIT, enabled: open });
  const { clear: clearStockSearch } = stockSearch;
  const stockResults = stockSearch.results;
  const stockLoading = stockSearch.status === 'debouncing' || stockSearch.status === 'loading';

  const trimmed = query.trim();
  const searchable = shouldSearch(trimmed, SEARCH_MIN_CHARS);

  useEffect(() => {
    if (open) setRecent(readRecents());
  }, [open]);

  const pushRecent = useCallback((href: string) => {
    try {
      const next = [{ href, at: Date.now() }, ...readRecents().filter((r) => r.href !== href)].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      setRecent(next);
    } catch { /* storage disabled — recents are a convenience only */ }
  }, []);

  const close = useCallback(() => {
    onOpenChange(false);
    setQuery('');
    clearStockSearch();
  }, [onOpenChange, clearStockSearch]);

  const handleNavigate = useCallback((href: string) => {
    pushRecent(href);
    close();
    router.push(href);
  }, [router, close, pushRecent]);

  /** A picked instrument is handed to Market Watch, which opens its real
   *  symbol-detail panel. A query parameter was used before and was silently
   *  dropped by every route. */
  const handleInstrument = useCallback((scrip: CanonicalInstrument) => {
    const symbol = scrip.tradingSymbol || scrip.symbol || '';
    if (!symbol) return;
    setPendingSymbol({
      symbol,
      token: scrip.token || undefined,
      name: scrip.name || undefined,
    });
    handleNavigate(INSTRUMENT_DESTINATION);
  }, [handleNavigate]);

  const filteredNav = useMemo(() => {
    if (!searchable) return [];
    const q = trimmed.toLowerCase();
    const matches = ALL_NAV_ITEMS.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.phaseLabel.toLowerCase().includes(q) ||
        item.keywords.some((k) => k.toLowerCase().includes(q)),
    );
    // Context-aware: the ACTIVE phase's pages rank first, then title/keyword
    // matches, so Trade surfaces orders/positions ahead of unrelated apps.
    return rankSearchResults(matches, q, activePhase);
  }, [trimmed, searchable, activePhase]);

  const groupedNav = useMemo<Record<string, SearchableItem[]>>(() => {
    return filteredNav.reduce((acc, item) => {
      if (!acc[item.phaseLabel]) acc[item.phaseLabel] = [];
      acc[item.phaseLabel].push(item);
      return acc;
    }, {} as Record<string, SearchableItem[]>);
  }, [filteredNav]);

  const handleRefresh = () => {
    setRefreshing(true);
    refresh();
    window.setTimeout(() => setRefreshing(false), 700);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search pages, stocks, actions…"
        value={query}
        onValueChange={setQuery}
        className="text-sm"
      />
      <CommandList>
        <CommandEmpty>
          {stockLoading ? (
            <span className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Searching…
            </span>
          ) : searchable ? (
            `No pages or instruments match “${trimmed}”.`
          ) : (
            `Type at least ${SEARCH_MIN_CHARS} characters to search instruments.`
          )}
        </CommandEmpty>

        {/* ---- Stocks & Instruments — canonical Search Engine rows ---- */}
        {stockResults.length > 0 && (
          <CommandGroup heading={`Stocks & Instruments (${fmtCount(stockResults.length)})`} aria-busy={stockSearch.isStale}>
            {stockResults.map((scrip: CanonicalInstrument, i) => {
              const symbol = scrip.tradingSymbol || scrip.symbol || '';
              const name = scrip.name;
              const exchange = scrip.exchangeSegment || scrip.exchange || '';
              const ltp = fmtPrice(scrip.ltp);
              return (
                <CommandItem
                  key={`${symbol}-${i}`}
                  value={`stock ${symbol} ${name ?? ''} ${exchange} ${scrip.instrumentType ?? ''}`}
                  onSelect={() => handleInstrument(scrip)}
                  className="gap-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-2">
                      <span className="font-semibold">{symbol}</span>
                      {name && <span className="truncate text-xs text-muted-foreground">{name}</span>}
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground/80">
                      Open symbol detail in Market Watch{exchange ? ` · ${exchange}` : ''}
                    </span>
                  </span>
                  <span className={ltpTone(ltp)}>{ltp != null ? `₹ ${ltp}` : 'no LTP'}</span>
                  <CommandShortcut><ArrowRight className="size-3" aria-hidden /></CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        {/* Honest instrument feedback — a typed query that matched pages but no
            instrument must say so, not look like there were no stocks at all. */}
        {searchable && !stockLoading && stockResults.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
            <SearchX className="size-3.5 shrink-0" aria-hidden />
            {stockSearch.error
              ? `Instrument search unavailable — ${stockSearch.error}`
              : `No instrument matches “${trimmed}”.`}
          </div>
        )}

        {/* ---- Navigation, grouped by phase ---- */}
        {Object.entries(groupedNav).map(([phaseLabel, items]) => (
          <CommandGroup key={phaseLabel} heading={phaseLabel}>
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.id}
                  value={`nav ${item.label} ${item.keywords.join(' ')} ${item.phaseLabel}`}
                  onSelect={() => handleNavigate(item.href)}
                  className="gap-2"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.badge && (
                    <CommandShortcut>
                      <span className="rounded-full bg-secondary px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-secondary-foreground">{item.badge}</span>
                    </CommandShortcut>
                  )}
                  <CommandShortcut><ArrowRight className="size-3" aria-hidden /></CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}

        {/* ---- Empty query: Recent + Quick actions + phase jump ---- */}
        {!searchable && (
          <>
            {recent.length > 0 && (
              <>
                <CommandGroup heading="Recent">
                  {recent.map((r) => (
                    <CommandItem
                      key={r.href}
                      value={`recent ${labelFor(r.href)} ${r.href}`}
                      onSelect={() => handleNavigate(r.href)}
                      className="gap-2"
                    >
                      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="flex-1 truncate">{labelFor(r.href)}</span>
                      <CommandShortcut><ArrowRight className="size-3" aria-hidden /></CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}

            <CommandGroup heading="Quick Actions">
              <CommandItem value="refresh system status snapshot" onSelect={handleRefresh} className="gap-2">
                <RefreshCw className={cn('size-4 shrink-0 text-muted-foreground', refreshing && 'animate-spin')} aria-hidden />
                <span className="flex-1">Refresh system status</span>
                {refreshing && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />}
              </CommandItem>
              {activePhase === 'data-saver' && (
                <CommandItem
                  value="run data quality scan"
                  disabled={scanning}
                  onSelect={() => {
                    if (scanning) return;
                    setScanning(true);
                    setScanDone(false);
                    postDataQuality('scan')
                      .catch(() => null)
                      .finally(() => {
                        setScanning(false);
                        setScanDone(true);
                        window.setTimeout(() => setScanDone(false), 1400);
                      });
                  }}
                  className="gap-2"
                >
                  <ScanSearch className={cn('size-4 shrink-0 text-muted-foreground', scanDone && 'text-success')} aria-hidden />
                  <span className="flex-1">{scanDone ? 'Scan started' : 'Run Data Quality scan'}</span>
                  {scanning && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />}
                </CommandItem>
              )}
            </CommandGroup>

            <CommandGroup heading="Jump to Phase">
              {KAUSTUBH_APPS.map((app) => (
                <CommandItem
                  key={app.id}
                  value={`app ${app.name} ${app.shortName}`}
                  onSelect={() => handleNavigate(app.defaultRoute)}
                  className="gap-2"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-primary via-primary to-secondary text-[9px] font-bold text-primary-foreground">
                    {app.monogram}
                  </span>
                  <span className="flex-1 truncate"><span className="font-medium">{app.name}</span></span>
                  <CommandShortcut><ArrowRight className="size-3" aria-hidden /></CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {/* ---- Footer hints: outside the scroll area so cmdk keyboard nav
                never walks into it, and hidden on phones where there is no
                physical keyboard ---- */}
        <div className="hidden items-center justify-center gap-x-4 gap-y-1 border-t border-border/50 px-4 py-2 text-[10px] text-muted-foreground sm:flex">
          <span><kbd className="rounded border bg-muted px-1 py-0.5 text-[9px]">↑↓</kbd> Navigate</span>
          <span><kbd className="rounded border bg-muted px-1 py-0.5 text-[9px]">Enter</kbd> Open</span>
          <span><kbd className="rounded border bg-muted px-1 py-0.5 text-[9px]">Esc</kbd> Close</span>
          <span><kbd className="rounded border bg-muted px-1 py-0.5 text-[9px]">Ctrl</kbd>K Search</span>
        </div>
      </CommandList>
    </CommandDialog>
  );
}

function ltpTone(ltp: string | null): string {
  return ltp != null
    ? 'shrink-0 text-[11px] font-semibold tabular-nums text-foreground/80'
    : 'shrink-0 text-[10px] text-muted-foreground/60';
}

/** Ctrl/Cmd+K toggles the palette. Ignored while a modifier-free keystroke is
 *  in flight and never re-fires while the palette is already open. */
export function useSearchShortcut(onToggle: (open: boolean) => void) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onToggle(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onToggle]);
}