'use client';

/**
 * Market Watch — live trading terminal (dashboard / trading routes).
 *
 * WORKING terminal, not a passive socket mirror:
 *   * REST first: /progress + /sections + /boards + /pins + /ranking load on
 *     mount, so the page paints real engine data even when the socket is down.
 *   * Realtime patch: `market_watch.status / .ranking / .pins` frames update the
 *     same state in place (1s throttle per frame type).
 *   * Live ticks: WS per-token ticks overlay REST rows; a 30s tick-snapshot
 *     poll covers tokens the socket has not delivered yet.
 *   * Search + symbol detail: full-universe /search with debounce and a
 *     /symbol/{id} detail panel (OHLC, circuit, depth, backend classification).
 *   * Global-search handoff: a symbol picked in the topbar command palette is
 *     delivered through `lib/pending-symbol` (one-shot) and opened in that same
 *     detail panel — the palette used to link to `?search=` which no route read,
 *     so the selection was silently lost.
 *
 * doc §24 compliance: every market fact rendered here is backend-owned. The
 * client only formats (fmt*) and overlays fresher backend values — it never
 * re-ranks, never infers tone from a sign, never invents a price.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, Gauge, Layers, Pin, PinOff, Plus,
  Radio, RefreshCw, ScanLine, Search, Trash2, TrendingDown, TrendingUp,
  Wifi, WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { getMarketWatchTickSnapshot } from '@/lib/api';
import { RealtimeChannelSpec } from '@/lib/realtime-ws';
import { takePendingSymbol } from '@/lib/pending-symbol';
import { cn } from '@/lib/utils';
import {
  MWRow,
  RECONCILE_INTERVAL_MS,
  fetchJson,
  lifecycleLabel,
  overlayRows,
  useEngineProgress,
} from '@/app/_pages/market-watch/mw-shared';

const CHANNEL = 'market_watch';
const STATE_FRAMES = ['market_watch.status', 'market_watch.ranking', 'market_watch.pins'];
const SNAPSHOT_MS = 30000;

/* ---------- presentation-only helpers (backend values in, strings out) --- */

function toneForClassification(classification: unknown): string {
  const c = String(classification ?? '').toUpperCase();
  if (c === 'DANGER' || c === 'INTRADAY_UNAVAILABLE') return 'text-red-500';
  if (c === 'GAINER') return 'text-emerald-500';
  if (c === 'LOSER') return 'text-red-500';
  return 'text-muted-foreground';
}

function fmtPct(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function fmtNum(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function fmtVol(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value >= 10000000
      ? `${(value / 10000000).toFixed(2)}Cr`
      : value >= 100000
        ? `${(value / 100000).toFixed(2)}L`
        : value.toLocaleString('en-IN')
    : '—';
}

function rowToken(r: any): string {
  return String(r?.token ?? r?.instrumentToken ?? '');
}

function rowSymbol(r: any): string {
  return String(r?.symbol ?? r?.tradingSymbol ?? rowToken(r) ?? '—');
}

function useIstClock(): string {
  const [now, setNow] = useState('');
  useEffect(() => {
    const f = () =>
      setNow(
        new Date().toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
      );
    f();
    const id = setInterval(f, 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* ------------------------------- component ------------------------------ */

export default function MarketWatchLivePage() {
  const { subscribe, onFrame, connected, ticks } = useFrontendRealtime();
  const { progress, state: lifecycleState, connected: engineConnected } = useEngineProgress();
  const clock = useIstClock();

  const [sections, setSections] = useState<Record<string, any[]>>({});
  const [boards, setBoards] = useState<Record<string, any[]>>({});
  // Full watch list (doc §16): the stocks the engine is actually watching —
  // ranked rows carry LTP/Chg% + flat 1m/2m/5m/10m timeframe changes.
  const [stocks, setStocks] = useState<any[]>([]);
  const [pins, setPins] = useState<{ gainers: any[]; losers: any[] }>({ gainers: [], losers: [] });
  // Manual pins: day-scoped, Mongo-backed (POST/DELETE /api/market-watch/pins).
  // Auto pins arrive on the socket frame (which never carries manual), so the
  // two sets are stored separately and never overwrite each other.
  const [manual, setManual] = useState<any[]>([]);
  const [manualCount, setManualCount] = useState(0);
  const [maxManual, setMaxManual] = useState(20);
  const [pinInput, setPinInput] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const [ranking, setRanking] = useState<any>(null);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [feedState, setFeedState] = useState<string | null>(null);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [universeSize, setUniverseSize] = useState<number | null>(null);
  const [indexVersion, setIndexVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  // tick-snapshot fallback for tokens the socket has not delivered yet
  const [snap, setSnap] = useState<Record<string, any>>({});
  // search + symbol detail
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState('stocks');
  // Price cap summary from the engine status (doc §16).
  const [priceCap, setPriceCap] = useState<number | null>(null);
  const [priceCappedCount, setPriceCappedCount] = useState<number | null>(null);
  const [watchableCount, setWatchableCount] = useState<number | null>(null);

  /* ----- REST load (primary path — works with socket down) ----- */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [sec, brd, pin, rank, list] = await Promise.all([
        fetchJson<any>('/api/market-watch/sections').catch(() => null),
        fetchJson<any>('/api/market-watch/boards').catch(() => null),
        fetchJson<any>('/api/market-watch/pins').catch(() => null),
        fetchJson<any>('/api/market-watch/ranking').catch(() => null),
        fetchJson<any>('/api/market-watch/rank?offset=0&limit=200&sortBy=changePercent&sortDir=desc').catch(() => null),
      ]);
      if (sec?.ok) {
        setSections(sec.sections ?? {});
        setFeedState(sec.feedState ?? null);
        setLiveCount(sec.liveStateCount ?? null);
        setUniverseSize(sec.universeSize ?? null);
        setIndexVersion(sec.indexVersion ?? null);
        if (sec.statusCounts) setStatusCounts(sec.statusCounts);
        if (typeof sec.priceCappedCount === 'number') setPriceCappedCount(sec.priceCappedCount);
        if (typeof sec.priceCap === 'number') setPriceCap(sec.priceCap);
        if (typeof sec.watchableCount === 'number') setWatchableCount(sec.watchableCount);
      }
      if (brd?.ok && brd.boards) setBoards(brd.boards);
      if (list?.ok && Array.isArray(list.items)) setStocks(list.items);
      if (pin && (pin.gainers || pin.pins || pin.manual)) {
        setPins({
          gainers: pin.gainers ?? pin.pins?.gainers ?? [],
          losers: pin.losers ?? pin.pins?.losers ?? [],
        });
        setManual(pin.manual ?? []);
        setManualCount(pin.manualCount ?? pin.manual?.length ?? 0);
        if (typeof pin.maxManualPins === 'number') setMaxManual(pin.maxManualPins);
      }
      if (rank?.ok ?? rank) setRanking(rank);
      setLastUpdated(
        new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      );
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Market Watch engine unreachable');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(true), RECONCILE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  /* ----- realtime state frames patch the same REST state ----- */
  useEffect(() => {
    void subscribe([{ channel: CHANNEL } satisfies RealtimeChannelSpec]).catch(() => {});
    const lastApplied = new Map<string, number>();
    return onFrame((frame) => {
      const type = frame?.type ?? '';
      if (!STATE_FRAMES.includes(type)) return;
      const now = Date.now();
      if (now - (lastApplied.get(type) ?? 0) < 1000) return;
      lastApplied.set(type, now);
      const d: any = frame.data ?? {};
      if (type === 'market_watch.status') {
        if (d.feedState) setFeedState(d.feedState);
        if (typeof d.liveStateCount === 'number') setLiveCount(d.liveStateCount);
        if (typeof d.universeSize === 'number') setUniverseSize(d.universeSize);
        if (typeof d.indexVersion === 'number') setIndexVersion(d.indexVersion);
        if (typeof d.priceCappedCount === 'number') setPriceCappedCount(d.priceCappedCount);
        if (typeof d.priceCap === 'number') setPriceCap(d.priceCap);
        if (typeof d.watchableCount === 'number') setWatchableCount(d.watchableCount);
        if (d.statusCounts) setStatusCounts(d.statusCounts);
      } else if (type === 'market_watch.ranking') {
        setRanking(d);
      } else if (type === 'market_watch.pins') {
        const p = d.pins ?? d;
        if (Array.isArray(p?.gainers) || Array.isArray(p?.losers)) {
          setPins({ gainers: p.gainers ?? [], losers: p.losers ?? [] });
        }
      }
    });
  }, [subscribe, onFrame]);

  /* ----- visible tokens: WS overlay + 30s tick-snapshot safety net ----- */
  const gainers: any[] = useMemo(() => {
    const s = sections.topGainers ?? sections.top_gainers ?? boards.top_gainers ?? [];
    const r = ranking?.top_gainers ?? ranking?.gainers ?? [];
    const merged = [...s, ...r].filter(Boolean);
    const seen = new Set<string>();
    return merged.filter((x) => {
      const t = rowToken(x);
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    }).slice(0, 20);
  }, [sections, boards, ranking]);

  const losers: any[] = useMemo(() => {
    const s = sections.topLosers ?? sections.top_losers ?? boards.top_losers ?? [];
    const r = ranking?.top_losers ?? ranking?.losers ?? [];
    const merged = [...s, ...r].filter(Boolean);
    const seen = new Set<string>();
    return merged.filter((x) => {
      const t = rowToken(x);
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    }).slice(0, 20);
  }, [sections, boards, ranking]);

  const movers: any[] = useMemo(() => {
    const fromBoards =
      boards.movers_1pct_5m ?? boards.movers_1pct_1m ?? boards.movers_5m ?? [];
    const fromRanking =
      ranking?.movers_1pct_5m ?? ranking?.movers_1pct_1m ?? ranking?.movers ?? [];
    const fromSections = sections.strongMovers ?? sections.fiveMinuteMovers ?? [];
    const merged = [...fromBoards, ...fromRanking, ...fromSections].filter(Boolean);
    const seen = new Set<string>();
    return merged.filter((x) => {
      const t = rowToken(x);
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    }).slice(0, 25);
  }, [boards, ranking, sections]);

  const visibleTokens = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of [...gainers, ...losers, ...movers, ...stocks, ...pins.gainers, ...pins.losers]) {
      const t = rowToken(r);
      if (t && !seen.has(t) && out.length < 120) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  }, [gainers, losers, movers, stocks, pins]);

  // keep per-token WS subscriptions for what is on screen
  useEffect(() => {
    if (!visibleTokens.length) return;
    const specs: RealtimeChannelSpec[] = visibleTokens.map((t) => ({
      channel: CHANNEL,
      instruments: [{ exchange_segment: 'nse_cm', instrument_token: t }],
    }));
    void subscribe(specs).catch(() => {});
  }, [subscribe, visibleTokens.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // tick-snapshot fallback for tokens without a WS tick yet
  useEffect(() => {
    if (!visibleTokens.length) return;
    let alive = true;
    const pull = async () => {
      try {
        const missing = visibleTokens.filter(
          (t) => !ticks.get(`nse_cm|${t}`) && !ticks.get(`NSE|${t}`),
        );
        if (!missing.length) return;
        const res = await getMarketWatchTickSnapshot(missing.slice(0, 60));
        if (!alive || !res?.rows) return;
        setSnap((prev) => ({ ...prev, ...res.rows }));
      } catch {
        /* snapshot is a safety net — WS + REST sections already painted */
      }
    };
    void pull();
    const id = setInterval(() => void pull(), SNAPSHOT_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [visibleTokens.join(','), ticks]); // eslint-disable-line react-hooks/exhaustive-deps

  const withLive = useCallback(
    (rows: any[]): MWRow[] => {
      const overlaid = overlayRows(rows as MWRow[], ticks);
      if (!Object.keys(snap).length) return overlaid;
      return overlaid.map((r: any) => {
        const s = snap[rowToken(r)];
        if (!s?.hasData) return r;
        return {
          ...r,
          ltp: typeof r.ltp === 'number' ? r.ltp : s.ltp ?? r.ltp,
          change: typeof r.change === 'number' ? r.change : s.change ?? r.change,
          changePercent:
            typeof r.changePercent === 'number' ? r.changePercent : s.changePercent ?? r.changePercent,
        };
      });
    },
    [ticks, snap],
  );

  const liveGainers = useMemo(() => withLive(gainers), [gainers, withLive]);
  const liveLosers = useMemo(() => withLive(losers), [losers, withLive]);
  const liveMovers = useMemo(() => withLive(movers), [movers, withLive]);
  const liveStocks = useMemo(() => withLive(stocks), [stocks, withLive]);

  /* ----- search (debounced, full universe) ----- */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetchJson<any>(
          `/api/market-watch/search?q=${encodeURIComponent(query.trim())}&limit=20&offset=0`,
        );
        setResults(res?.items ?? res?.results ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const openSymbol = useCallback(async (sym: string, token?: string) => {
    const id = sym.trim();
    if (!id && !token) return;
    // Prefer the numeric token: /symbol/{token} resolves reliably while the
    // symbol-string lookup depends on the instrument-cache naming variant.
    const keys = [token, id].filter(Boolean) as string[];
    setSelected(id || token || '');
    setDetailLoading(true);
    setTab('detail');
    try {
      let res: any = null;
      for (const k of keys) {
        res = await fetchJson<any>(`/api/market-watch/symbol/${encodeURIComponent(k)}`);
        if (res?.ok) break;
      }
      setDetail(res?.ok ? res : null);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /* ----- global command palette → this page's real symbol-detail panel ----- */
  useEffect(() => {
    const pending = takePendingSymbol();
    if (!pending) return;
    // Seed the page's own search field so the user sees WHY this panel opened.
    setQuery(pending.symbol);
    void openSymbol(pending.symbol, pending.token);
  }, [openSymbol]);

  /* ----- manual pins (engine: Mongo day-scoped, max 20) ----- */
  const refreshManual = useCallback(async () => {
    try {
      const res = await fetchJson<any>('/api/market-watch/pins');
      setPins({
        gainers: res.gainers ?? res.pins?.gainers ?? [],
        losers: res.losers ?? res.pins?.losers ?? [],
      });
      setManual(res.manual ?? []);
      setManualCount(res.manualCount ?? res.manual?.length ?? 0);
      if (typeof res.maxManualPins === 'number') setMaxManual(res.maxManualPins);
    } catch {
      /* pins panel keeps last state; notice surfaces the failure */
    }
  }, []);

  const manualTokens = useMemo(() => new Set(manual.map((p: any) => String(p?.token)).filter(Boolean)), [manual]);

  const addPin = useCallback(async (symbolOrToken: string) => {
    const id = symbolOrToken.trim();
    if (!id || pinBusy) return;
    setPinBusy(true);
    setPinNotice(null);
    try {
      const res = await fetchJson<any>('/api/market-watch/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: id }),
      });
      setPinNotice(
        res.ok
          ? res.alreadyPinned
            ? `Already pinned: ${id.toUpperCase()}`
            : `Pinned ${id.toUpperCase()} for today`
          : `Could not pin: ${res.reason ?? 'unknown'}`,
      );
      if (res.ok) {
        setPinInput('');
        await refreshManual();
      }
    } catch {
      setPinNotice('Could not pin — backend unavailable');
    } finally {
      setPinBusy(false);
    }
  }, [pinBusy, refreshManual]);

  const removePin = useCallback(async (token: string) => {
    // DELETE takes the raw token path (no _resolve_token) — always send token.
    try {
      await fetchJson(`/api/market-watch/pins/${encodeURIComponent(token)}`, { method: 'DELETE' });
      await refreshManual();
    } catch {
      setPinNotice('Could not unpin — backend unavailable');
    }
  }, [refreshManual]);

  const togglePin = useCallback(async (symbol: string, token: string | undefined, isPinned: boolean) => {
    if (isPinned && token) await removePin(token);
    else await addPin(token || symbol);
  }, [addPin, removePin]);

  const clearPins = useCallback(async () => {
    try {
      await fetchJson('/api/market-watch/pins', { method: 'DELETE' });
      await refreshManual();
    } catch {
      setPinNotice('Could not clear pins — backend unavailable');
    }
  }, [refreshManual]);

  /* ----- breadth ----- */
  const adv = liveGainers.length;
  const dec = liveLosers.length;
  const live = liveCount ?? statusCounts.LIVE ?? 0;
  const hasAny = adv + dec + liveMovers.length + liveStocks.length + live > 0 || Object.keys(sections).length > 0;
  const socketLive = connected;
  const feedLive = String(feedState ?? '').toUpperCase() === 'CONNECTED' || engineConnected;

  return (
    <div className="space-y-4">
      {/* terminal header */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-card via-card to-muted/20">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <span className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
              <Layers className="h-5 w-5" />
              {feedLive && (
                <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
              )}
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Market Watch</h1>
              <p className="text-[11px] text-muted-foreground">
                {lifecycleState !== 'UNKNOWN' ? lifecycleLabel(lifecycleState) : 'Engine state resolving…'}
                {indexVersion != null ? ` · v${indexVersion}` : ''}
                {lastUpdated ? ` · ${lastUpdated} IST` : ''} · {clock} IST
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(socketLive ? 'border-emerald-500/50 text-emerald-500' : 'border-amber-500/50 text-amber-500')}
            >
              {socketLive ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
              {socketLive ? 'WS live' : 'WS offline · REST'}
            </Badge>
            <Badge
              variant="outline"
              className={cn(feedLive ? 'border-emerald-500/50 text-emerald-500' : 'border-slate-500/50 text-muted-foreground')}
            >
              <Radio className="mr-1 h-3 w-3" />
              {feedState ?? (feedLive ? 'CONNECTED' : '—')}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => load()} disabled={refreshing}>
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              <span className="ml-1.5 hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>

        {/* breadth strip */}
        <div className="grid grid-cols-2 gap-2 border-t border-border/50 p-3 sm:grid-cols-3 lg:grid-cols-6">
          <Strip label="Live / Watch" value={universeSize != null ? `${live}/${watchableCount ?? universeSize}` : '—'} tone="text-sky-500" />
          <Strip label="Advancing" value={String(adv)} tone="text-emerald-500" icon={<ArrowUpRight className="h-3 w-3" />} />
          <Strip label="Declining" value={String(dec)} tone="text-red-500" icon={<ArrowDownRight className="h-3 w-3" />} />
          <Strip label="Movers (1% board)" value={String(liveMovers.length)} tone="text-violet-500" />
          <Strip label="Pins G/L" value={`${pins.gainers.length}/${pins.losers.length}`} tone="text-amber-500" />
          <Strip label="Price cap" value={priceCap ? `₹${priceCap}${priceCappedCount ? ` · ${priceCappedCount} above` : ''}` : '—'} tone="text-muted-foreground" />
        </div>

        {/* search */}
        <div className="border-t border-border/50 p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim()) void openSymbol(query.trim());
              }}
              placeholder="Search full universe — symbol, name, token… (Enter opens detail)"
              className="pl-9"
            />
          </div>
          {searching && <p className="mt-1.5 text-[11px] text-muted-foreground">Searching…</p>}
          {results.length > 0 && (
            <div className="mt-2 max-h-56 overflow-auto rounded-lg border border-border/60">
              {results.slice(0, 20).map((r: any, i: number) => (
                <button
                  key={`${rowToken(r)}-${i}`}
                  onClick={() => void openSymbol(rowSymbol(r), rowToken(r) || undefined)}
                  className="flex w-full items-center justify-between gap-2 border-b border-border/40 px-3 py-2 text-left text-sm last:border-0 hover:bg-accent/60"
                >
                  <span className="font-medium">{rowSymbol(r)}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-mono tabular-nums">{fmtNum(r.ltp)}</span>
                    <span className={cn('tabular-nums', toneForClassification(r.classification))}>
                      {fmtPct(r.changePercent ?? r.change_5m_pct)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
            <span className="text-destructive">{error} — REST fallback failed, retrying…</span>
            <Button size="sm" variant="outline" onClick={() => load()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      {loading && !hasAny ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground/50" />
            <p className="font-semibold">Loading live engine state…</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Reading progress, sections, boards and pins from the backend.
            </p>
          </CardContent>
        </Card>
      ) : !hasAny ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
            <Activity className="h-8 w-8 text-muted-foreground/50" />
            <p className="font-semibold">No data yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              The engine has not published a live universe in this window
              {progress?.lifecycle?.state ? ` (state: ${progress.lifecycle.state})` : ''}.
              Live data flows {progress?.lifecycle?.schedule ? 'inside the configured runtime window' : 'during market hours'}.
              Stored reports remain available on the Services → Market Watch page.
            </p>
            <Button size="sm" variant="outline" onClick={() => load()}>Retry now</Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="stocks" className="gap-1.5 text-xs">
              <Layers className="h-3.5 w-3.5" /> Stocks ({liveStocks.length})
            </TabsTrigger>
            <TabsTrigger value="movers" className="gap-1.5 text-xs">
              <Gauge className="h-3.5 w-3.5" /> Movers
            </TabsTrigger>
            <TabsTrigger value="scan" className="gap-1.5 text-xs">
              <ScanLine className="h-3.5 w-3.5" /> Scan all
            </TabsTrigger>
            <TabsTrigger value="gainers" className="gap-1.5 text-xs">
              <TrendingUp className="h-3.5 w-3.5" /> Gainers ({adv})
            </TabsTrigger>
            <TabsTrigger value="losers" className="gap-1.5 text-xs">
              <TrendingDown className="h-3.5 w-3.5" /> Losers ({dec})
            </TabsTrigger>
            <TabsTrigger value="pins" className="gap-1.5 text-xs">
              <Pin className="h-3.5 w-3.5" /> Pins ({pins.gainers.length + pins.losers.length})
            </TabsTrigger>
            <TabsTrigger value="detail" className="gap-1.5 text-xs">
              <Search className="h-3.5 w-3.5" /> Detail{selected ? ` · ${selected}` : ''}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="stocks" className="mt-3">
            <StocksTable
              rows={liveStocks}
              empty={
                priceCap
                  ? `No stocks under the ₹${priceCap} watch list yet — only LTP ≤ ₹${priceCap} stocks are subscribed and monitored.`
                  : 'No stocks in the watch list yet.'
              }
              onSelect={(s, t) => void openSymbol(s, t)}
              pinned={manualTokens}
              onTogglePin={togglePin}
            />
          </TabsContent>

          <TabsContent value="movers" className="mt-3">
            <QuoteTable
              title="Live movers — engine 1% board"
              rows={liveMovers}
              empty="No movers on the backend 1% board yet."
              onSelect={(s, t) => void openSymbol(s, t)}
              pinned={manualTokens}
              onTogglePin={togglePin}
            />
          </TabsContent>

          <TabsContent value="scan" className="mt-3">
            <UniverseScan onSelect={(s, t) => void openSymbol(s, t)} />
          </TabsContent>

          <TabsContent value="gainers" className="mt-3">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <QuoteTable title="Top gainers" rows={liveGainers} empty="No gainers published yet." onSelect={(s, t) => void openSymbol(s, t)} pinned={manualTokens} onTogglePin={togglePin} />
              <QuoteTable title="Top losers" rows={liveLosers} empty="No losers published yet." onSelect={(s, t) => void openSymbol(s, t)} pinned={manualTokens} onTogglePin={togglePin} />
            </div>
          </TabsContent>

          <TabsContent value="losers" className="mt-3">
            <QuoteTable title="Top losers" rows={liveLosers} empty="No losers published yet." onSelect={(s, t) => void openSymbol(s, t)} pinned={manualTokens} onTogglePin={togglePin} />
          </TabsContent>

          <TabsContent value="pins" className="mt-3">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <QuoteTable title="Pinned gainers (engine Top-5 frequency)" rows={withLive(pins.gainers)} empty="No pinned gainers yet." onSelect={(s, t) => void openSymbol(s, t)} pinned={manualTokens} onTogglePin={togglePin} />
              <QuoteTable title="Pinned losers (engine Top-5 frequency)" rows={withLive(pins.losers)} empty="No pinned losers yet." onSelect={(s, t) => void openSymbol(s, t)} pinned={manualTokens} onTogglePin={togglePin} />
            </div>
            <Card className="mt-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Pin className="h-4 w-4 text-primary" /> Manual pins
                  <span className="text-[11px] font-normal text-muted-foreground">day-scoped · server-side</span>
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="tabular-nums">{manualCount}/{maxManual}</Badge>
                  {manualCount > 0 && (
                    <Button size="sm" variant="outline" onClick={() => void clearPins()}>
                      <Trash2 className="h-3.5 w-3.5" /> Clear
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    placeholder="Symbol or token to pin (e.g. RELIANCE / 2885)"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void addPin(pinInput); }}
                  />
                  <Button size="sm" onClick={() => void addPin(pinInput)} disabled={pinBusy || !pinInput.trim()}>
                    {pinBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Pin
                  </Button>
                </div>
                {pinNotice && <p className="text-xs text-muted-foreground">{pinNotice}</p>}
                {manual.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No manual pins — pin any symbol to keep it visible. Pins reset with the trading day.</p>
                ) : (
                  <div className="divide-y divide-border rounded-lg border">
                    {manual.map((p: any) => (
                      <div key={p.token} className="flex items-center justify-between px-3 py-2 text-sm">
                        <button
                          className="flex min-w-0 items-center gap-2 text-left hover:underline"
                          onClick={() => void openSymbol(String(p.symbol ?? p.token), String(p.token))}
                        >
                          <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />
                          <span className="font-medium">{p.symbol}</span>
                          {p.name && <span className="max-w-[220px] truncate text-xs text-muted-foreground">{p.name}</span>}
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label={`Unpin ${p.symbol}`}
                          onClick={() => void removePin(String(p.token))}
                        >
                          <PinOff className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="detail" className="mt-3">
            <SymbolDetail symbol={selected} detail={detail} loading={detailLoading} />
          </TabsContent>
        </Tabs>
      )}

      {Object.keys(statusCounts).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Engine stock status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(statusCounts).map(([k, v]) => (
              <Badge key={k} variant="outline" className="tabular-nums">
                {k}: {v}
              </Badge>
            ))}
            <span className="ml-auto text-[11px] text-muted-foreground">
              Full workspace (filters, rank, weekly review, report) lives on Services → Market Watch
            </span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------ sub-views ------------------------------- */

/** 1m/2m/5m/10m timeframe columns the watch list renders (doc §19/§16). */
const STOCK_TF_COLUMNS = ['1m', '2m', '5m', '10m'] as const;

function StocksTable({ rows, empty, onSelect, pinned, onTogglePin }: {
  rows: any[];
  empty: string;
  onSelect: (symbol: string, token?: string) => void;
  pinned?: Set<string>;
  onTogglePin?: (symbol: string, token: string | undefined, isPinned: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">Watch list</CardTitle>
        <Badge variant="outline" className="tabular-nums">{rows.length}</Badge>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="max-h-[560px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">Chg%</TableHead>
                  {STOCK_TF_COLUMNS.map((tf) => (
                    <TableHead key={tf} className="text-right">{tf} %</TableHead>
                  ))}
                  <TableHead className="text-right">Vol</TableHead>
                  <TableHead>Circuit</TableHead>
                  <TableHead>Class</TableHead>
                  {onTogglePin && <TableHead className="w-10">Pin</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r: any, i: number) => {
                  const tone = toneForClassification(r.classification);
                  const sym = rowSymbol(r);
                  const tok = rowToken(r) || undefined;
                  const isPinned = !!tok && !!pinned?.has(tok);
                  const upper = typeof r.upperCircuit === 'number' ? r.upperCircuit : null;
                  const lower = typeof r.lowerCircuit === 'number' ? r.lowerCircuit : null;
                  return (
                    <TableRow
                      key={`${tok || sym}-${i}`}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => onSelect(sym, tok)}
                    >
                      <TableCell className="font-medium">{sym}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.ltp)}</TableCell>
                      <TableCell className={cn('text-right font-semibold tabular-nums', tone)}>
                        {fmtPct(r.changePercent)}
                      </TableCell>
                      {STOCK_TF_COLUMNS.map((tf) => {
                        const pct = r[`change_${tf}_pct`];
                        return (
                          <TableCell
                            key={tf}
                            className={cn(
                              'text-right tabular-nums',
                              typeof pct === 'number'
                                ? pct > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : pct < 0
                                    ? 'text-red-600 dark:text-red-400'
                                    : 'text-muted-foreground'
                                : 'text-muted-foreground',
                            )}
                          >
                            {fmtPct(pct)}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtVol(r.volume)}</TableCell>
                      <TableCell className="text-[11px] font-mono tabular-nums text-muted-foreground">
                        {lower != null && upper != null ? `${fmtNum(lower)}–${fmtNum(upper)}` : '—'}
                      </TableCell>
                      <TableCell className={cn('text-[11px] uppercase', tone)}>
                        {r.classification ?? '—'}
                      </TableCell>
                      {onTogglePin && (
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-label={isPinned ? `Unpin ${sym}` : `Pin ${sym}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onTogglePin(sym, tok, isPinned);
                            }}
                          >
                            {isPinned
                              ? <Pin className="h-3.5 w-3.5 text-primary" />
                              : <PinOff className="h-3.5 w-3.5 text-muted-foreground/60" />}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Strip({ label, value, tone, icon }: { label: string; value: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('flex items-center gap-1 text-lg font-bold tabular-nums', tone)}>
        {icon}
        {value}
      </p>
    </div>
  );
}

function QuoteTable({ title, rows, empty, onSelect, pinned, onTogglePin }: {
  title: string;
  rows: any[];
  empty: string;
  onSelect: (symbol: string, token?: string) => void;
  pinned?: Set<string>;
  onTogglePin?: (symbol: string, token: string | undefined, isPinned: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Badge variant="outline" className="tabular-nums">{rows.length}</Badge>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="max-h-[460px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">Chg%</TableHead>
                  <TableHead className="text-right">Vol</TableHead>
                  <TableHead>Class</TableHead>
                  {onTogglePin && <TableHead className="w-10">Pin</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r: any, i: number) => {
                  const tone = toneForClassification(r.classification);
                  const sym = rowSymbol(r);
                  const tok = rowToken(r) || undefined;
                  const isPinned = !!tok && !!pinned?.has(tok);
                  return (
                    <TableRow
                      key={`${tok || sym}-${i}`}
                      className="cursor-pointer hover:bg-accent/50"
                      onClick={() => onSelect(sym, tok)}
                    >
                      <TableCell className="font-medium">{sym}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{fmtNum(r.ltp)}</TableCell>
                      <TableCell className={cn('text-right font-semibold tabular-nums', tone)}>
                        {fmtPct(r.changePercent ?? r.change_5m_pct)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtVol(r.volume)}</TableCell>
                      <TableCell className={cn('text-[11px] uppercase', tone)}>
                        {r.classification ?? '—'}
                      </TableCell>
                      {onTogglePin && (
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-label={isPinned ? `Unpin ${sym}` : `Pin ${sym}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onTogglePin(sym, tok, isPinned);
                            }}
                          >
                            {isPinned
                              ? <Pin className="h-3.5 w-3.5 text-primary" />
                              : <PinOff className="h-3.5 w-3.5 text-muted-foreground/60" />}
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SymbolDetail({ symbol, detail, loading }: { symbol: string | null; detail: any; loading: boolean }) {
  if (!symbol) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          Search above or click any row — the symbol detail opens here with quote, circuit and depth.
        </CardContent>
      </Card>
    );
  }
  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading {symbol}…
        </CardContent>
      </Card>
    );
  }
  if (!detail) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-sm text-muted-foreground">
          No detail for {symbol} — the engine has no record for it in this session.
        </CardContent>
      </Card>
    );
  }
  const rec = detail.record ?? {};
  const quote = detail.quote ?? {};
  const circuit = detail.circuit ?? {};
  const depth = detail.depth ?? {};
  const buys: any[] = depth.buy ?? [];
  const sells: any[] = depth.sell ?? [];
  const tone = toneForClassification(rec.classification ?? quote.classification);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            {detail.symbol ?? symbol}
            <Badge variant="outline" className={cn(tone)}>{rec.classification ?? '—'}</Badge>
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            token {detail.token ?? rec.token ?? '—'} · {detail.tradingDate ?? ''} · {detail.feedState ?? ''}
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2 text-center">
            <DetailCell label="LTP" value={fmtNum(rec.ltp ?? quote.ltp)} big tone={tone} />
            <DetailCell label="Change %" value={fmtPct(rec.changePercent ?? quote.changePercent)} big tone={tone} />
            <DetailCell label="Volume" value={fmtVol(rec.volume ?? quote.volume)} big />
            <DetailCell label="Open" value={fmtNum(rec.open ?? quote.open)} />
            <DetailCell label="High" value={fmtNum(rec.high ?? quote.high)} />
            <DetailCell label="Low" value={fmtNum(rec.low ?? quote.low)} />
            <DetailCell label="Prev close" value={fmtNum(rec.prevClose ?? quote.prevClose)} />
            <DetailCell label="Upper circuit" value={fmtNum(circuit.upperCircuit)} />
            <DetailCell label="Lower circuit" value={fmtNum(circuit.lowerCircuit)} />
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            state: {detail.state?.status ?? rec.status ?? '—'}
            {' · '}intraday: {String(detail.state?.intradayEligible ?? rec.intradayEligible ?? '—')}
            {' · '}price source: {detail.state?.priceSource ?? '—'}
            {detail.manualPinned ? ' · manually pinned' : ''}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Market depth ({depth.source ?? '—'})</CardTitle>
        </CardHeader>
        <CardContent>
          {!depth.available && (
            <p className="mb-2 text-[11px] text-muted-foreground">Depth unavailable for this symbol right now.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase text-emerald-500">Buy</p>
              {buys.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
              {buys.slice(0, 5).map((d: any, i: number) => (
                <div key={i} className="flex justify-between font-mono text-xs tabular-nums">
                  <span>{fmtNum(d.price)}</span>
                  <span className="text-muted-foreground">{fmtVol(d.quantity)}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase text-red-500">Sell</p>
              {sells.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
              {sells.slice(0, 5).map((d: any, i: number) => (
                <div key={i} className="flex justify-between font-mono text-xs tabular-nums">
                  <span>{fmtNum(d.price)}</span>
                  <span className="text-muted-foreground">{fmtVol(d.quantity)}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailCell({ label, value, big, tone }: { label: string; value: string; big?: boolean; tone?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/60 px-2 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('font-mono tabular-nums', big ? 'text-base font-bold' : 'text-sm', tone)}>{value}</p>
    </div>
  );
}

/* ------------------------- full-universe scan ---------------------------
 * Pages the engine's ranked universe end-to-end (GET /rank, broker-free) and
 * tallies the BACKEND's own per-row values into one breadth picture: status
 * distribution, advancers/decliners, danger list, no-data list. Display order
 * of the top tables follows backend fields; nothing is re-derived.
 * ------------------------------------------------------------------------ */

const SCAN_PAGE = 1000;

function UniverseScan({ onSelect }: { onSelect: (symbol: string, token?: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [regSize, setRegSize] = useState<number | null>(null);
  const [feedState, setFeed] = useState<string | null>(null);
  // Engine's own danger board (official ranking rows carry the typed
  // classification; /rank serves legacy flat rows where it may be null).
  const [dangerBoard, setDangerBoard] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const [reg, boards] = await Promise.all([
        fetchJson<any>('/api/market-watch/registry').catch(() => null),
        fetchJson<any>('/api/market-watch/boards').catch(() => null),
      ]);
      if (reg?.ok) {
        setRegSize(reg.universeSize ?? reg.items?.length ?? null);
        setFeed(reg.feedState ?? null);
      }
      if (boards?.ok && boards.boards) {
        setDangerBoard(boards.boards.circuit_danger ?? []);
      } else {
        setDangerBoard([]);
      }
      const all: any[] = [];
      let offset = 0;
      let totalCount: number | null = null;
      for (let page = 0; page < 6; page++) {
        const res = await fetchJson<any>(
          `/api/market-watch/rank?offset=${offset}&limit=${SCAN_PAGE}&sortBy=changePercent&sortDir=desc`,
        );
        if (!res?.ok) throw new Error('rank unavailable');
        totalCount = res.total ?? totalCount;
        all.push(...(res.items ?? []));
        if (!res.hasMore || !(res.items ?? []).length) break;
        offset += (res.items ?? []).length;
      }
      setRows(all);
      setTotal(totalCount ?? all.length);
      setScannedAt(
        new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
      );
    } catch (e: any) {
      setError(e?.message ?? 'Universe scan failed');
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const tally = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let adv = 0;
    let dec = 0;
    let live = 0;
    for (const r of rows) {
      const st = String(r?.status ?? 'UNKNOWN');
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      const cp = r?.changePercent;
      if (typeof cp === 'number' && Number.isFinite(cp)) {
        if (cp > 0) adv++;
        else if (cp < 0) dec++;
        live++;
      }
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);
    const gainers = [...rows]
      .filter((r) => typeof r?.changePercent === 'number' && r.changePercent > 0)
      .sort((a, b) => num(b.changePercent) - num(a.changePercent))
      .slice(0, 10);
    const losers = [...rows]
      .filter((r) => typeof r?.changePercent === 'number' && r.changePercent < 0)
      .sort((a, b) => num(a.changePercent) - num(b.changePercent))
      .slice(0, 10);
    // Danger prefers the engine's own circuit_danger board; the classification
    // filter covers rows that already carry the typed field.
    const danger = dangerBoard.length
      ? dangerBoard
      : rows.filter((r) => String(r?.classification ?? '').toUpperCase() === 'DANGER');
    const unavail = rows.filter(
      (r) => String(r?.classification ?? '').toUpperCase() === 'INTRADAY_UNAVAILABLE',
    );
    const noPrice = rows.filter((r) => r?.ltp == null);
    return { byStatus, adv, dec, unchanged: Math.max(0, rows.length - adv - dec), live, gainers, losers, danger, unavail, noPrice };
  }, [rows, dangerBoard]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-violet-500" />
            <div>
              <p className="font-semibold">Full universe scan</p>
              <p className="text-[11px] text-muted-foreground">
                {regSize != null ? `${regSize} in registry` : 'registry size resolving…'}
                {total != null ? ` · ${total} ranked rows` : ''}
                {feedState ? ` · feed ${feedState}` : ''}
                {scannedAt ? ` · scanned ${scannedAt} IST` : ''}
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => void runScan()} disabled={scanning}>
            <RefreshCw className={cn('h-3.5 w-3.5', scanning && 'animate-spin')} />
            <span className="ml-1.5">{scanning ? 'Scanning…' : 'Re-scan'}</span>
          </Button>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {scanning && rows.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" /> Scanning every stock in the engine universe…
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Strip label="Scanned" value={String(rows.length)} tone="text-sky-500" />
            <Strip label="Advancing" value={String(tally.adv)} tone="text-emerald-500" />
            <Strip label="Declining" value={String(tally.dec)} tone="text-red-500" />
            <Strip label="Unchanged" value={String(tally.unchanged)} tone="text-muted-foreground" />
            <Strip label="Danger" value={String(tally.danger.length)} tone="text-red-500" />
            <Strip label="No price" value={String(tally.noPrice.length)} tone="text-amber-500" />
          </div>

          {Object.keys(tally.byStatus).length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Status distribution (engine feed status)</CardTitle></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {Object.entries(tally.byStatus).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="tabular-nums">{k}: {v}</Badge>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <QuoteTable title="Scan: top gainers" rows={tally.gainers} empty="No advancing stocks in this scan." onSelect={onSelect} />
            <QuoteTable title="Scan: top losers" rows={tally.losers} empty="No declining stocks in this scan." onSelect={onSelect} />
          </div>

          {tally.danger.length > 0 && (
            <QuoteTable title="Scan: danger (engine classification)" rows={tally.danger} empty="" onSelect={onSelect} />
          )}
          {tally.unavail.length > 0 && (
            <QuoteTable title="Scan: intraday unavailable" rows={tally.unavail} empty="" onSelect={onSelect} />
          )}
          {tally.noPrice.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">No live price ({tally.noPrice.length})</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {tally.noPrice.slice(0, 60).map((r: any, i: number) => (
                  <button
                    key={`${rowToken(r) || i}`}
                    onClick={() => onSelect(rowSymbol(r), rowToken(r) || undefined)}
                    className="rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent"
                  >
                    {rowSymbol(r)}
                  </button>
                ))}
                {tally.noPrice.length > 60 && (
                  <span className="px-1 py-1 text-xs text-muted-foreground">+{tally.noPrice.length - 60} more</span>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
