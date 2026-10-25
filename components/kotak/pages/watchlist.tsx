'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Search, Star, TrendingDown, TrendingUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, SectionCard, StatusBadge } from '@/components/design-system';
import {
  getWatchlist, addToWatchlist, removeFromWatchlist, toggleWatchlistFavorite,
  getWatchlistCards, getWatchlistDynamicListFor,
} from '@/lib/api';
import type { WatchlistCard } from '@/lib/api';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import { SEARCH_SUGGESTION_LIMIT } from '@/lib/instrument-search';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { KotakPage } from '@/components/kotak/ui';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

type WatchRow = {
  _id?: string;
  symbol: string;
  token: string;
  exchange: string;
  favorite?: boolean;
};

const STATUS_TONE: Record<string, string> = {
  LIVE: 'text-emerald-500',
  STALE: 'text-amber-500',
  CONNECTING: 'text-sky-500',
  DISCONNECTED: 'text-muted-foreground',
};

const DYNAMIC_KINDS: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'top_gainers', label: 'Top Gainers' },
  { id: 'top_losers', label: 'Top Losers' },
  { id: 'm5_gainers', label: '5-Min Gainers' },
  { id: 'm5_losers', label: '5-Min Losers' },
  { id: 'm10_gainers', label: '10-Min Gainers' },
  { id: 'movers_down', label: '-1% Movers' },
];

export default function KotakWatchlist() {
  const { latest, connected } = useLatestTicks(true);
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cardMap, setCardMap] = useState<Record<string, WatchlistCard>>({});
  const [dynamicKind, setDynamicKind] = useState('');
  const [rankedTokens, setRankedTokens] = useState<string[] | null>(null);
  const { toast } = useToast();

  // Debounce, cancellation and stale-response guarding live in the shared hook,
  // so the Add-Symbol box no longer races a late response into the list.
  const search = useInstrumentSearch(query, { limit: SEARCH_SUGGESTION_LIMIT });
  const searching = search.status === 'debouncing' || search.status === 'loading';
  const results = useMemo(
    () => search.results.map((r) => ({
      symbol: r.symbol || r.tradingSymbol,
      token: r.token,
      exchange: r.exchangeSegment || r.exchange || 'nse_cm',
      name: r.name,
    })),
    [search.results],
  );

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const res = await getWatchlist();
      setRows(Array.isArray(res?.data) ? res.data.map((r: any) => ({
        _id: r._id, symbol: r.symbol, token: String(r.token || ''),
        exchange: r.exchange || 'nse_cm', favorite: Boolean(r.favorite),
      })) : []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'watchlist unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const pullCards = useCallback(async (stocks: WatchRow[]) => {
    if (stocks.length === 0) { setCardMap({}); return; }
    try {
      const res = await getWatchlistCards(stocks.map((s) => ({
        symbol: s.symbol, token: s.token, exchange: s.exchange,
      })));
      const map: Record<string, WatchlistCard> = {};
      for (const card of res?.data ?? []) {
        if (card?.token) map[String(card.token)] = card;
      }
      setCardMap(map);
    } catch { /* the SSE tick stream keeps LTP updating */ }
  }, []);

  useEffect(() => {
    if (rows.length === 0) { setCardMap({}); return; }
    const timer = window.setTimeout(() => { void pullCards(rows); }, 350);
    const interval = window.setInterval(() => { void pullCards(rows); }, 15000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [rows, pullCards]);

  useEffect(() => {
    if (!dynamicKind || rows.length === 0) { setRankedTokens(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getWatchlistDynamicListFor(dynamicKind, rows.map((r) => ({
        symbol: r.symbol, token: r.token, exchange: r.exchange,
      })), rows.length)
        .then((res) => {
          if (!cancelled) setRankedTokens((res?.data ?? []).map((c) => String(c.token)));
        })
        .catch(() => { if (!cancelled) setRankedTokens(null); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [dynamicKind, rows, cardMap]);

  const displayRows = rankedTokens
    ? (rankedTokens
        .map((t) => rows.find((r) => String(r.token) === t))
        .filter((r): r is WatchRow => Boolean(r)))
    : rows;

  const cardFor = useCallback((row: WatchRow): WatchlistCard | undefined =>
    cardMap[String(row.token)], [cardMap]);

  const ltpFor = useCallback((row: WatchRow): number | null => {
    const live = latest.get(row.symbol);
    if (live && typeof live.ltp === 'number' && live.ltp > 0) return live.ltp;
    const card = cardMap[String(row.token)];
    return card && typeof card.ltp === 'number' && card.ltp > 0 ? card.ltp : null;
  }, [latest, cardMap]);

  const addSymbol = async (row: { symbol: string; token: string; exchange: string }) => {
    if (!row.symbol) return;
    try {
      await addToWatchlist({ symbol: row.symbol, token: row.token, exchange: row.exchange, favorite: false });
      setQuery('');
      search.clear();
      await reload();
      toast({ title: 'Added to watchlist', description: `${row.symbol} added — live ticks will track its LTP.` });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Add failed', description: e?.detail ?? e?.message });
    }
  };

  const removeSymbol = async (symbol: string) => {
    try {
      await removeFromWatchlist(symbol);
      await reload();
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Remove failed', description: e?.detail ?? e?.message });
    }
  };

  const toggleFavorite = async (symbol: string) => {
    try {
      await toggleWatchlistFavorite(symbol);
      await reload();
    } catch { /* keep */ }
  };

  if (error && !loading) {
    return (
      <KotakPage title="Watchlist">
        <ErrorState message={error} onRetry={() => void reload()} />
      </KotakPage>
    );
  }

  return (
    <KotakPage title="Watchlist">
      <SectionCard
        title="Add Symbol"
        icon={Search}
        headerRight={
          <StatusBadge
            status={connected ? 'success' : 'neutral'}
            label={connected ? 'LIVE TICKS' : 'TICK FEED OFFLINE'}
          />
        }
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search NSE scrip, e.g. RELIANCE, INFY, TATAMOTORS…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
          {searching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>

        {results.length > 0 && (
          <div className="mt-2 rounded-md border bg-background shadow-sm">
            {results.map((r) => (
              <div key={`${r.exchange}-${r.symbol}`} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{r.symbol}</span>
                  {r.name ? <span className="ml-2 truncate text-xs text-muted-foreground">{r.name}</span> : null}
                  <span className="ml-2 text-[10px] text-muted-foreground">{r.exchange}</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => void addSymbol(r)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Watchlist"
        icon={Star}
        headerRight={
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      >
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Star}
            title="Watchlist is empty"
            description="Search a scrip above and press Add — it will stream real LTP through the shared tick feed."
          />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {DYNAMIC_KINDS.map((k) => (
                <Button
                  key={k.id || 'all'}
                  variant={dynamicKind === k.id ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setDynamicKind(k.id)}
                >
                  {k.label}
                </Button>
              ))}
            </div>
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">LTP</TableHead>
                <TableHead className="text-right">Day change</TableHead>
                <TableHead className="text-right">5m %</TableHead>
                <TableHead className="text-right">10m %</TableHead>
                <TableHead className="text-right">Bid / Ask</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((r, i) => {
                const card = cardFor(r);
                const ltp = ltpFor(r);
                const change = card?.change ?? null;
                const changePct = card?.changePercent ?? null;
                const tone = (change ?? 0) > 0 ? 'text-emerald-500' : (change ?? 0) < 0 ? 'text-red-500' : 'text-muted-foreground';
                const status = card?.status ?? 'DISCONNECTED';
                return (
                  <TableRow key={r._id ?? `${r.symbol}-${i}`}>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void toggleFavorite(r.symbol)}>
                        <Star className={cn('h-3.5 w-3.5', r.favorite ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.symbol}</span>
                        <Badge variant="outline" className="text-[10px]">{r.exchange.toUpperCase()}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {ltp != null ? `₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {change == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={cn('inline-flex items-center justify-end gap-1 font-mono tabular-nums', tone)}>
                          {change > 0 ? <TrendingUp className="h-3 w-3" /> : change < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                          {change > 0 ? '+' : ''}{change.toFixed(2)}
                          {changePct != null ? <span className="text-[10px] opacity-70">({changePct.toFixed(2)}%)</span> : null}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {card?.fiveMinPercent != null ? `${card.fiveMinPercent > 0 ? '+' : ''}${card.fiveMinPercent.toFixed(2)}%` : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {card?.tenMinPercent != null ? `${card.tenMinPercent > 0 ? '+' : ''}${card.tenMinPercent.toFixed(2)}%` : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums text-xs">
                      {card?.bid != null && card?.ask != null
                        ? `${card.bid.toFixed(2)} / ${card.ask.toFixed(2)}`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <span className={cn('text-[11px] font-medium', STATUS_TONE[status] ?? 'text-muted-foreground')}>
                        {status}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void removeSymbol(r.symbol)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </>
        )}
      </SectionCard>
    </KotakPage>
  );
}