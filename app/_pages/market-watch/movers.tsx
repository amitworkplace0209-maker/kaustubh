'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TrendingUp, TrendingDown, Activity, Clock, Gauge, Search, RefreshCw, ArrowUpRight, Zap, AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  SectionCard, LoadingState, EmptyState,
} from '@/components/design-system';
import {
  SectionsPayload, MWRow, MwBoardsResponse, fetchJson, dedupe, useMarketWatchRealtime, overlayRows,
  RECONCILE_INTERVAL_MS, RAW_TICK_BUDGET,
} from './mw-shared';
import { MwRowRow, MwTableShell } from './mw-table';

interface PageResponse {
  ok: boolean;
  section: string;
  offset: number;
  limit: number;
  count: number;
  total: number;
  hasMore: boolean;
  items: MWRow[];
}

interface SearchResponse {
  ok: boolean;
  query: string;
  offset: number;
  count: number;
  total: number;
  items: MWRow[];
}

const SECTION_META: { key: string; api: string; title: string; icon: React.ElementType; accent: string }[] = [
  { key: 'topGainers', api: 'top_gainers', title: 'Top Gainers', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'topLosers', api: 'top_losers', title: 'Top Losers', icon: TrendingDown, accent: 'text-red-600 dark:text-red-400' },
  { key: 'highestVolume', api: 'highest_volume', title: 'Highest Volume', icon: Activity, accent: 'text-blue-600 dark:text-blue-400' },
  { key: 'mostActive', api: 'most_active', title: 'Most Active', icon: Activity, accent: 'text-blue-600 dark:text-blue-400' },
  { key: 'highestTurnover', api: 'highest_turnover', title: 'Highest Turnover', icon: Gauge, accent: 'text-violet-600 dark:text-violet-400' },
  { key: 'buyingStrength', api: 'buying_strength', title: 'Buying Strength', icon: ArrowUpRight, accent: 'text-cyan-600 dark:text-cyan-400' },
  { key: 'highestAbsoluteChange', api: 'highest_absolute_change', title: 'Highest Absolute Change', icon: Gauge, accent: 'text-violet-600 dark:text-violet-400' },
  // doc §21/§22 — the per-timeframe 1% boards. These were computed by the engine
  // but had no UI at all; `most_active` and `circuit_*` were likewise unreachable.
  { key: 'movers_1pct_1m', api: 'movers_1pct_1m', title: 'Top 1% — 1m', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'movers_1pct_2m', api: 'movers_1pct_2m', title: 'Top 1% — 2m', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'movers_1pct_5m', api: 'movers_1pct_5m', title: 'Top 1% — 5m', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'movers_1pct_10m', api: 'movers_1pct_10m', title: 'Top 1% — 10m', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'movers_1pct_30m', api: 'movers_1pct_30m', title: 'Top 1% — 30m', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'decliners_1pct_1m', api: 'decliners_1pct_1m', title: 'Bottom 1% — 1m', icon: TrendingDown, accent: 'text-red-600 dark:text-red-400' },
  { key: 'decliners_1pct_2m', api: 'decliners_1pct_2m', title: 'Bottom 1% — 2m', icon: TrendingDown, accent: 'text-red-600 dark:text-red-400' },
  { key: 'decliners_1pct_10m', api: 'decliners_1pct_10m', title: 'Bottom 1% — 10m', icon: TrendingDown, accent: 'text-red-600 dark:text-red-400' },
  { key: 'decliners_1pct_30m', api: 'decliners_1pct_30m', title: 'Bottom 1% — 30m', icon: TrendingDown, accent: 'text-red-600 dark:text-red-400' },
  { key: 'circuit_near', api: 'circuit_near', title: 'Circuit Near', icon: Zap, accent: 'text-amber-600 dark:text-amber-400' },
  { key: 'circuit_danger', api: 'circuit_danger', title: 'Circuit Danger', icon: AlertTriangle, accent: 'text-red-600 dark:text-red-400' },
  { key: 'strongMovers', api: 'strong_movers', title: 'Strong Movers (+1%)', icon: TrendingUp, accent: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'weakMovers', api: 'weak_movers', title: 'Weak Movers (-1%)', icon: TrendingDown, accent: 'text-red-600 dark:text-red-400' },
  { key: 'fiveMinuteMovers', api: 'five_minute_movers', title: '5-Minute Movers', icon: Clock, accent: 'text-cyan-600 dark:text-cyan-400' },
  { key: 'tenMinuteMovers', api: 'ten_minute_movers', title: '10-Minute Movers', icon: Clock, accent: 'text-cyan-600 dark:text-cyan-400' },
];

/** doc §22 boards whose rows carry circuit/margin context worth showing. */
const CIRCUIT_BOARDS = new Set(['circuit_near', 'circuit_danger']);

export default function MoversTab({ onOpenSymbol }: { onOpenSymbol: (row: MWRow) => void }) {
  const [sections, setSections] = useState<Record<string, MWRow[]>>({});
  const [metadata, setMetadata] = useState<SectionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [paging, setPaging] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [pinSets, setPinSets] = useState<{ gainers: Set<string>; losers: Set<string> }>({ gainers: new Set(), losers: new Set() });

  // doc §26 — raw ticks go to the rows this tab actually renders. The boards
  // themselves are the engine's controlled publish set, so the only tokens that
  // need a raw stream are the ones on screen plus the active search result.
  // The previous build accumulated up to 500 raw streams and never released any
  // of them; the shared hook now reference-counts and drops what leaves.
  const { tokens, truncated } = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const consider = (t: string | undefined) => {
      if (!t || seen.has(t) || out.length >= RAW_TICK_BUDGET) return;
      seen.add(t);
      out.push(t);
    };
    for (const rows of Object.values(sections)) for (const r of rows) consider(r.token);
    for (const s of searchResults?.items ?? []) consider(s.token);
    return { tokens: out, truncated: seen.size < (Object.values(sections).reduce((n, rows) => n + rows.length, 0) + (searchResults?.items.length ?? 0)) };
  }, [sections, searchResults]);
  const { ticks, connectionState, connected, frames } = useMarketWatchRealtime(tokens);

  useEffect(() => {
    // Paint pinned badges from the realtime pins frame (or REST on mount).
    let cancelled = false;
    const applyPins = (gainers: any[], losers: any[]) => {
      if (cancelled) return;
      setPinSets({
        gainers: new Set(gainers.map((p) => String(p?.token)).filter(Boolean)),
        losers: new Set(losers.map((p) => String(p?.token)).filter(Boolean)),
      });
    };
    fetchJson<{ ok: boolean; gainers: any[]; losers: any[] }>('/api/market-watch/pins')
      .then((r) => { if (r?.ok) applyPins(r.gainers ?? [], r.losers ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const frame = frames['market_watch.pins'];
    const data = (frame as any)?.data;
    if (data?.pins && Array.isArray(data.pins.gainers)) {
      setPinSets({
        gainers: new Set(data.pins.gainers.map((p: any) => String(p?.token)).filter(Boolean)),
        losers: new Set(data.pins.losers.map((p: any) => String(p?.token)).filter(Boolean)),
      });
    }
  }, [frames]);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchJson<SectionsPayload>('/api/market-watch/sections');
      if (!res.ok) throw new Error('sections unavailable');
      setSections(res.sections);
      setMetadata(res);
      // doc §21/§22: the 1% mover boards, Circuit Danger and Most Active live on
      // the engine's official ranking boards, not in `/sections`. Read them from
      // `/boards` so every spec board is reachable. Rows stay backend-owned.
      const boards = await fetchJson<MwBoardsResponse>('/api/market-watch/boards').catch(() => null);
      if (boards?.ok && boards.boards) {
        setSections((prev) => {
          const next = { ...prev };
          for (const meta of SECTION_META) {
            if (next[meta.key]?.length) continue; // `/sections` already answered
            const rows = boards.boards[meta.api];
            if (rows?.length) next[meta.key] = rows;
          }
          return next;
        });
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load sections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // doc §25/§26 — the boards change on the engine's own publish cadence and
    // arrive as `market_watch.status` / `.ranking` frames, with the exact
    // refetch keyed on `indexVersion` below. This interval is ONLY the safety
    // net while the socket cannot deliver, not the update path.
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (connected) return;
      fetchData();
    }, RECONCILE_INTERVAL_MS);
    return () => { if (iv) clearInterval(iv); };
  }, [fetchData, connected]);

  // A new board version IS a board change, so refetch exactly when the engine
  // says the publish set moved. Keying on `indexVersion` rather than on "any
  // frame arrived" is what keeps this from becoming a per-second refetch: the
  // status frame is broadcast continuously but the version only advances when
  // the published data actually changed.
  const seenIndexVersion = useRef<number | null>(null);
  useEffect(() => {
    const fromFrame = (frames['market_watch.status']?.data as any)?.indexVersion;
    const next = Number(fromFrame ?? metadata?.indexVersion);
    if (!Number.isFinite(next)) return;
    if (seenIndexVersion.current === null) { seenIndexVersion.current = next; return; }
    if (seenIndexVersion.current === next) return;
    seenIndexVersion.current = next;
    void fetchData();
  }, [frames, metadata?.indexVersion, fetchData]);

  const loadMore = useCallback(async (api: string, key: string) => {
    const current = sections[key] ?? [];
    setPaging((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetchJson<PageResponse>(`/api/market-watch/page?section=${api}&offset=${current.length}&limit=100`);
      if (res.ok && res.items.length) {
        setSections((s) => ({ ...s, [key]: dedupe([...(s[key] ?? []), ...res.items]) }));
        setHasMore((h) => ({ ...h, [key]: res.hasMore }));
      } else {
        setHasMore((h) => ({ ...h, [key]: false }));
      }
    } catch {
      setError('Failed to load more rows');
    } finally {
      setPaging((p) => ({ ...p, [key]: false }));
    }
  }, [sections]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setSearchResults(null); return; }
    setSearching(true);
    try {
      const res = await fetchJson<SearchResponse>(`/api/market-watch/search?q=${encodeURIComponent(q)}&limit=100&offset=0`);
      setSearchResults(res);
    } catch {
      setSearchResults({ ok: false, query: q, offset: 0, count: 0, total: 0, items: [] });
    } finally {
      setSearching(false);
    }
  }, []);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    searchTimer.current = setTimeout(() => runSearch(searchQuery), 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQuery, runSearch]);

  const gPinTokens = pinSets.gainers;
  const lPinTokens = pinSets.losers;

  const liveSections = useMemo(() => {
    const out: Record<string, MWRow[]> = {};
    for (const [k, v] of Object.entries(sections)) out[k] = overlayRows(v, ticks);
    return out;
  }, [sections, ticks]);

  return (
    <div className="space-y-4">
      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>}

      {/* Full Market Search (docs §17): matching LIVE/PENDING rows, no new feed */}
      <SectionCard title="Full Market Search" icon={Search}>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Search symbol / name / token… (debounced)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(searchQuery); }}
            />
            <Button size="sm" onClick={() => runSearch(searchQuery)} disabled={searching}>
              {searching ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          {searching ? <LoadingState text="Searching…" />
            : searchResults && searchResults.items.length === 0 && searchQuery.trim() ? (
              <EmptyState icon={Search} title="No matches" description={`No results for "${searchQuery}"`} />
            ) : searchResults && searchResults.items.length ? (
              <MwTableShell
                headerCells={['#', 'Symbol', 'LTP', 'Δ%', '5m%', 'Vol', 'Pin', 'Status']}
              >
                {searchResults.items.map((s, i) => (
                  <MwRowRow key={s.token} row={s} index={i} cols={{ momentum: true, volume: true }} onClick={() => onOpenSymbol(s)} />
                ))}
              </MwTableShell>
            ) : null}
          {searchResults && (
            <Badge variant="outline" className="tabular-nums">{searchResults.total} matches</Badge>
          )}
        </div>
      </SectionCard>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{connectionState}</Badge>
          <span>{metadata?.liveStateCount ?? 0} live state · {metadata?.universeSize ?? 0} universe</span>
        </div>
        <Button size="sm" variant="ghost" onClick={fetchData}><RefreshCw className="h-3.5 w-3.5" /></Button>
      </div>

      {/* Ranking sections (docs §9, §15, §18, §21, §22) */}
      <div className="grid gap-4 md:grid-cols-2">
        {SECTION_META.map((meta) => {
          const rows = liveSections[meta.key] ?? [];
          const pinned = meta.key === 'topGainers' ? gPinTokens : meta.key === 'topLosers' ? lPinTokens : undefined;
          // doc §14/§17 — circuit boards carry distance + margin context; 1%
          // boards carry per-timeframe movement.
          const isCircuit = CIRCUIT_BOARDS.has(meta.api);
          const isTfMover = meta.api.includes('_1pct_');
          const cols = {
            momentum: !isTfMover,
            volume: !isTfMover,
            circuit: isCircuit,
            timeframes: isTfMover,
            classification: true,
          };
          const headers = ['#', 'Symbol', 'LTP', 'Δ%'];
          if (cols.momentum) headers.push('5m%');
          if (cols.timeframes) headers.push('1m', '2m', '5m', '10m', '30m');
          if (cols.circuit) headers.push('Circuit', 'Margin');
          if (cols.classification) headers.push('Class');
          if (cols.volume) headers.push('Vol');
          headers.push('Pin', 'Status');
          return (
            <SectionCard
              key={meta.key}
              title={meta.title}
              icon={meta.icon}
              className="shadow-soft"
              headerRight={<Badge variant="outline" className="tabular-nums">{rows.length}</Badge>}
            >
              {loading ? <LoadingState text="Loading…" />
                : rows.length === 0 ? (
                  <EmptyState icon={meta.icon} title={`No rows in ${meta.title} — market may be closed or engine warming up.`} />
                ) : (
                  <MwTableShell
                    headerCells={headers}
                    onLoadMore={() => loadMore(meta.api, meta.key)}
                    hasMore={rows.length >= 20 && (hasMore[meta.key] ?? true)}
                    paging={paging[meta.key] ?? false}
                  >
                    {rows.map((s, i) => (
                      <MwRowRow key={`${s.token}-${i}`} row={s} index={i} cols={cols} pinned={pinned?.has(s.token)} onClick={() => onOpenSymbol(s)} />
                    ))}
                  </MwTableShell>
                )}
            </SectionCard>
          );
        })}
      </div>
    </div>
  );
}