'use client';

/*
 * Unified Watchlist — SINGLE source of truth for BOTH routes:
 *   /data-saver/watch-list   and   /trading/watchlist
 *
 * Full redesign from zero (advanced pro-terminal):
 *  - One backend: GET/POST/DELETE /api/phase2/watch-list
 *  - One live feed: shared SSE (/api/ticks/stream) with flash + reconnect
 *  - Auto gainers/losers/flat classification, no refresh
 *  - Pro table + cards view, search, favs, sorting, momentum strip,
 *    day-range bar, tick age, quick BUY/SELL (paper), CSV export
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Eye,
  LayoutGrid,
  List,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Star,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtPrice, fmtNumber, fmtCompact, sign } from '@/components/design-system';
import { cn } from '@/lib/utils';
import { useInstrumentSearch } from '@/hooks/use-instrument-search';
import { SEARCH_SUGGESTION_LIMIT, type CanonicalInstrument } from '@/lib/instrument-search';
import { subscribeTicks, subscribeSseState } from '@/lib/shared-sse';
import { placeDemoOrder } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

// ---------------------------------------------------------------- types

interface WatchListItem {
  watchlistId: string | null;
  symbol: string;
  tradingSymbol: string;
  companyName: string | null;
  instrumentToken: string;
  exchange: string;
  exchangeSegment: string;
  isin: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  marketData: {
    ltp: number | null;
    change: number | null;
    changePct: number | null;
    prevClose: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    bid: number | null;
    ask: number | null;
    lastTickAt: string | null;
    tickAgeSec: number | null;
    available: boolean;
    momentum: Record<string, number | null>;
  };
}

type Side = 'all' | 'gainers' | 'losers' | 'flat' | 'fav';
type SortKey = 'pct' | 'change' | 'ltp' | 'volume' | 'm5' | 'm10' | 'symbol';
type ViewMode = 'table' | 'cards';

const WINDOWS = ['1m', '3m', '5m', '10m', '15m', '30m', '60m'] as const;
const FAV_KEY = 'unified-watchlist:favs:v1';

function toIst(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function classify(pct: number | null): 'gainers' | 'losers' | 'flat' {
  if (pct == null || !Number.isFinite(pct)) return 'flat';
  if (pct > 0) return 'gainers';
  if (pct < 0) return 'losers';
  return 'flat';
}

// ---------------------------------------------------------------- main

export default function UnifiedWatchlist() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<WatchListItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // toolbar
  const [filter, setFilter] = useState('');
  const [side, setSide] = useState<Side>('all');
  const [sortBy, setSortBy] = useState<SortKey>('pct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [view, setView] = useState<ViewMode>('table');

  // selection / dialogs
  const [showAdd, setShowAdd] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [toRemove, setToRemove] = useState<WatchListItem | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ordering, setOrdering] = useState<string | null>(null);
  const [qtyByToken, setQtyByToken] = useState<Record<string, number>>({});

  // live
  const [connected, setConnected] = useState(false);
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const [now, setNow] = useState(() => new Date());
  const [favs, setFavs] = useState<Set<string>>(new Set());

  const itemsRef = useRef<WatchListItem[]>([]);
  itemsRef.current = items;
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // favs persist
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      if (raw) setFavs(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleFav = useCallback((token: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // ---- data load (single backend for both pages)
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/phase2/watch-list', { cache: 'no-store' });
      const d = await res.json();
      if (!mountedRef.current) return;
      if (d.ok && Array.isArray(d.data)) {
        setItems(d.data);
        setError(null);
      } else {
        setError(d.error ?? 'Watchlist unavailable');
      }
    } catch {
      if (mountedRef.current) setError('Backend se connect nahi ho paya.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20000); // momentum refresh fallback
    return () => clearInterval(t);
  }, [load]);

  // ---- shared SSE: ONE connection, flash on LTP move
  useEffect(() => {
    const offState = subscribeSseState((s) => setConnected(s.connected));
    const offTicks = subscribeTicks((t: Record<string, unknown>) => {
      const token = String(
        (t as Record<string, unknown>).tk ??
          (t as Record<string, unknown>).instrumentToken ??
          (t as Record<string, unknown>).token ??
          '',
      );
      if (!token) return;
      const cur = itemsRef.current.find((i) => String(i.instrumentToken) === token);
      if (!cur) return;
      const raw = t as Record<string, unknown>;
      const num = (v: unknown): number | null => {
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const nextLtp = num(raw.ltp ?? raw.last_price) ?? cur.marketData.ltp;
      const prevLtp = cur.marketData.ltp;

      if (nextLtp != null && prevLtp != null && nextLtp !== prevLtp) {
        const dir = nextLtp > prevLtp ? 'up' : 'down';
        setFlash((p) => ({ ...p, [token]: dir }));
        const old = flashTimers.current.get(token);
        if (old) clearTimeout(old);
        const timer = setTimeout(() => {
          setFlash((p) => {
            const n = { ...p };
            delete n[token];
            return n;
          });
        }, 900);
        flashTimers.current.set(token, timer);
      }

      const patch: WatchListItem = {
        ...cur,
        marketData: {
          ...cur.marketData,
          ltp: nextLtp,
          change: num(raw.change) ?? cur.marketData.change,
          changePct: num((raw as Record<string, unknown>).changePercent ?? (raw as Record<string, unknown>).changePct) ?? cur.marketData.changePct,
          volume: num(raw.volume) ?? cur.marketData.volume,
          high: num(raw.high) ?? cur.marketData.high,
          low: num(raw.low) ?? cur.marketData.low,
          open: num(raw.open) ?? cur.marketData.open,
          prevClose: num((raw as Record<string, unknown>).close) ?? cur.marketData.prevClose,
          bid: num((raw as Record<string, unknown>).bp ?? raw.bid) ?? cur.marketData.bid,
          ask: num((raw as Record<string, unknown>).sp ?? raw.ask) ?? cur.marketData.ask,
          lastTickAt: typeof raw.ts === 'string' ? (raw.ts as string) : typeof (raw as Record<string, unknown>).receivedAt === 'string' ? ((raw as Record<string, unknown>).receivedAt as string) : cur.marketData.lastTickAt,
          tickAgeSec: 0,
          available: true,
        },
      };
      setItems((prev) => prev.map((i) => (String(i.instrumentToken) === token ? patch : i)));
    });
    return () => {
      offState();
      offTicks();
    };
  }, []);

  // ---- clock + tick-age ticker
  useEffect(() => {
    const t = setInterval(() => {
      setNow(new Date());
      setItems((prev) =>
        prev.map((i) =>
          i.marketData.tickAgeSec == null
            ? i
            : { ...i, marketData: { ...i.marketData, tickAgeSec: Math.min(3599, i.marketData.tickAgeSec + 1) } },
        ),
      );
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- add / remove
  const {
    results: hits,
    status: searchStatus,
    clear: clearSearch,
  } = useInstrumentSearch(addQuery, { limit: SEARCH_SUGGESTION_LIMIT });
  const searching = searchStatus === 'debouncing' || searchStatus === 'loading';

  const addStock = useCallback(
    async (hit: CanonicalInstrument) => {
      try {
        const res = await fetch('/api/phase2/watch-list', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: hit.symbol,
            instrumentToken: hit.token,
            exchangeSegment: hit.exchangeSegment,
            isin: hit.isin,
            companyName: hit.name,
            tradingSymbol: hit.tradingSymbol,
          }),
        });
        const d = await res.json();
        if (!res.ok || !d.ok) {
          toast({ variant: 'destructive', title: 'Add failed', description: d.error ?? 'Failed to add stock' });
          return;
        }
        setAddQuery('');
        clearSearch();
        setShowAdd(false);
        await load();
        toast({ title: `${hit.symbol} added`, description: 'Live ticks ab is symbol ko track karenge.' });
      } catch {
        toast({ variant: 'destructive', title: 'Add failed', description: 'Network error' });
      }
    },
    [load, clearSearch, toast],
  );

  const confirmRemove = useCallback(async () => {
    if (!toRemove) return;
    const token = toRemove.instrumentToken;
    try {
      await fetch(`/api/phase2/watch-list?token=${encodeURIComponent(token)}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((i) => i.instrumentToken !== token));
      if (expanded === token) setExpanded(null);
    } catch {
      /* keep */
    }
    setToRemove(null);
  }, [toRemove, expanded]);

  const quickOrder = useCallback(
    async (item: WatchListItem, txn: 'BUY' | 'SELL') => {
      const token = item.instrumentToken;
      if (ordering) return;
      const qty = Math.max(1, Math.floor(qtyByToken[token] ?? 1));
      const ltp = item.marketData.ltp ?? 0;
      setOrdering(`${token}:${txn}`);
      try {
        const res = await placeDemoOrder({
          symbol: item.symbol,
          tradingSymbol: item.tradingSymbol || item.symbol,
          token,
          exchange: item.exchangeSegment || 'nse_cm',
          transactionType: txn,
          product: 'MIS',
          orderType: 'MKT',
          quantity: qty,
          price: 0,
          triggerPrice: 0,
          ltp,
        });
        toast({ title: `${txn} ${item.symbol} × ${qty} placed`, description: `Order ${(res as { demoOrder?: { orderId?: string } })?.demoOrder?.orderId ?? ''} · MKT · MIS` });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Order failed';
        toast({ variant: 'destructive', title: `${txn} failed`, description: msg });
      } finally {
        setOrdering(null);
      }
    },
    [ordering, qtyByToken, toast],
  );

  const exportCsv = useCallback(() => {
    const rows = itemsRef.current;
    if (rows.length === 0) return;
    const head = 'symbol,company,token,ltp,change,changePct,open,high,low,prevClose,volume,bid,ask\n';
    const body = rows
      .map((r) => {
        const m = r.marketData;
        return [
          r.symbol,
          `"${(r.companyName ?? '').replace(/"/g, '""')}"`,
          r.instrumentToken,
          m.ltp ?? '',
          m.change ?? '',
          m.changePct ?? '',
          m.open ?? '',
          m.high ?? '',
          m.low ?? '',
          m.prevClose ?? '',
          m.volume ?? '',
          m.bid ?? '',
          m.ask ?? '',
        ].join(',');
      })
      .join('\n');
    const blob = new Blob([head + body], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `watchlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  // ---- derived stats
  const stats = useMemo(() => {
    let g = 0;
    let l = 0;
    let f = 0;
    let live = 0;
    let sum = 0;
    let n = 0;
    let topG: WatchListItem | null = null;
    let topL: WatchListItem | null = null;
    for (const it of items) {
      const c = classify(it.marketData.changePct);
      if (c === 'gainers') {
        g += 1;
        if (!topG || (it.marketData.changePct ?? -Infinity) > (topG.marketData.changePct ?? -Infinity)) topG = it;
      } else if (c === 'losers') {
        l += 1;
        if (!topL || (it.marketData.changePct ?? Infinity) < (topL.marketData.changePct ?? Infinity)) topL = it;
      } else f += 1;
      if (it.marketData.tickAgeSec != null && it.marketData.tickAgeSec <= 60) live += 1;
      if (it.marketData.changePct != null && Number.isFinite(it.marketData.changePct)) {
        sum += it.marketData.changePct;
        n += 1;
      }
    }
    return { g, l, f, live, avg: n > 0 ? sum / n : null, topG, topL, total: items.length };
  }, [items]);

  const alreadyIn = useMemo(() => new Set(items.map((i) => String(i.instrumentToken))), [items]);

  // ---- visible list: side + fav + text + sort
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = items.filter((it) => {
      const c = classify(it.marketData.changePct);
      if (side === 'gainers' && c !== 'gainers') return false;
      if (side === 'losers' && c !== 'losers') return false;
      if (side === 'flat' && c !== 'flat') return false;
      if (side === 'fav' && !favs.has(String(it.instrumentToken))) return false;
      if (q) {
        const hay = `${it.symbol} ${(it.companyName ?? '').toLowerCase()} ${it.instrumentToken} ${(it.isin ?? '').toLowerCase()}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      const A = a.marketData;
      const B = b.marketData;
      let r = 0;
      switch (sortBy) {
        case 'change':
          r = (A.change ?? -Infinity) - (B.change ?? -Infinity);
          break;
        case 'ltp':
          r = (A.ltp ?? -Infinity) - (B.ltp ?? -Infinity);
          break;
        case 'volume':
          r = (A.volume ?? -Infinity) - (B.volume ?? -Infinity);
          break;
        case 'm5':
          r = (A.momentum?.['5m'] ?? -Infinity) - (B.momentum?.['5m'] ?? -Infinity);
          break;
        case 'm10':
          r = (A.momentum?.['10m'] ?? -Infinity) - (B.momentum?.['10m'] ?? -Infinity);
          break;
        case 'symbol':
          return sortDir === 'asc' ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
        default:
          r = (A.changePct ?? -Infinity) - (B.changePct ?? -Infinity);
      }
      return sortDir === 'desc' ? -r : r;
    });
    return list;
  }, [items, filter, side, favs, sortBy, sortDir]);

  const istClock = now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });

  const cycleSort = (k: SortKey) => {
    if (sortBy === k) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortBy(k);
      setSortDir(k === 'symbol' ? 'asc' : 'desc');
    }
  };

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-4 pb-6">
      {/* HERO header */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.08] via-transparent to-success/[0.06]" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/60 text-primary-foreground shadow-lg">
            <Eye className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Watchlist</h1>
            <p className="mt-0.5 truncate text-xs text-muted-foreground sm:text-sm">
              Live NSE EQ terminal · {stats.total} symbol{stats.total === 1 ? '' : 's'} · auto gainers / losers · 1 SSE connection
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums',
                connected ? 'border-success/40 bg-success/10 text-success' : 'border-warning/40 bg-warning/10 text-warning',
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-success' : 'bg-warning')} />
              {connected ? 'LIVE' : 'CONNECTING'}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
              <Clock className="h-3 w-3" /> IST {istClock}
            </span>
            <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={items.length === 0} className="gap-1.5">
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
            <Button size="sm" onClick={() => setShowAdd(true)} className="gap-1.5 shadow-md">
              <Plus className="h-4 w-4" /> Add Stock
            </Button>
          </div>
        </div>
        {/* breadth strip */}
        <div className="relative flex h-1.5 w-full overflow-hidden bg-muted/60">
          {stats.total > 0 && (
            <>
              <span className="h-full bg-success transition-all" style={{ width: `${(stats.g / stats.total) * 100}%` }} />
              <span className="h-full bg-muted-foreground/30 transition-all" style={{ width: `${(stats.f / stats.total) * 100}%` }} />
              <span className="h-full bg-destructive transition-all" style={{ width: `${(stats.l / stats.total) * 100}%` }} />
            </>
          )}
        </div>
      </div>

      {/* STATS */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatMini tone="neutral" label="Total" value={String(stats.total)} sub={`${stats.live} live ticks`} icon={Activity} />
        <StatMini tone="success" label="Gainers" value={String(stats.g)} sub={stats.topG ? `${stats.topG.symbol} ${sign(stats.topG.marketData.changePct)}${(stats.topG.marketData.changePct ?? 0).toFixed(2)}%` : '—'} icon={TrendingUp} />
        <StatMini tone="danger" label="Losers" value={String(stats.l)} sub={stats.topL ? `${stats.topL.symbol} ${(stats.topL.marketData.changePct ?? 0).toFixed(2)}%` : '—'} icon={TrendingDown} />
        <StatMini tone="muted" label="Flat" value={String(stats.f)} sub="0% / no tick" icon={Minus} />
        <StatMini tone="live" label="Live now" value={String(stats.live)} sub={connected ? 'SSE streaming' : 'reconnecting…'} icon={Zap} />
        <StatMini tone="avg" label="Avg change" value={stats.avg == null ? '—' : `${sign(stats.avg)}${stats.avg.toFixed(2)}%`} sub="across list" icon={ArrowUpDown} avg={stats.avg} />
      </div>

      {/* TOOLBAR */}
      <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter: symbol, company, token, ISIN…" className="h-9 pl-8 pr-8 text-xs" />
            {filter && (
              <button onClick={() => setFilter('')} aria-label="Clear filter" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
            {(
              [
                ['all', `All ${stats.total}`],
                ['gainers', `Gainers ${stats.g}`],
                ['losers', `Losers ${stats.l}`],
                ['flat', `Flat ${stats.f}`],
                ['fav', `Fav ${favs.size}`],
              ] as [Side, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setSide(k)}
                className={cn(
                  'rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
                  side === k ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                  k === 'gainers' && side === k && 'text-success',
                  k === 'losers' && side === k && 'text-destructive',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-xl border border-border bg-muted/40 p-1">
              <button onClick={() => setView('table')} aria-label="Table view" className={cn('rounded-lg p-1.5', view === 'table' ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground')}>
                <List className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => setView('cards')} aria-label="Cards view" className={cn('rounded-lg p-1.5', view === 'cards' ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground')}>
                <LayoutGrid className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  ['pct', '%'],
                  ['change', '₹'],
                  ['ltp', 'LTP'],
                  ['volume', 'Vol'],
                  ['m5', '5m'],
                  ['m10', '10m'],
                  ['symbol', 'A-Z'],
                ] as [SortKey, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => cycleSort(k)}
                  className={cn(
                    'rounded-lg border px-2 py-1.5 text-[11px] font-medium tabular-nums transition-colors',
                    sortBy === k ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {sortBy === k && (sortDir === 'desc' ? ' ↓' : ' ↑')}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* BODY */}
      {loading && items.length === 0 ? (
        <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/60" />
          ))}
          <p className="py-2 text-center text-xs text-muted-foreground">Watchlist load ho rahi hai…</p>
        </div>
      ) : error && items.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-destructive/30 bg-card px-6 py-14 text-center">
          <p className="text-sm font-semibold text-destructive">Watchlist unavailable</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">{error}</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={() => void load()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/60">
            <Search className="h-6 w-6 text-muted-foreground/60" />
          </span>
          <p className="mt-3 text-sm font-semibold">{items.length === 0 ? 'Watchlist khaali hai' : 'Koi match nahi mila'}</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {items.length === 0
              ? 'Add Stock dabakar real NSE EQ symbol add karo — live LTP, gainers/losers aur momentum yahin dikhega.'
              : 'Filter ya tab badlo, ya naya symbol add karo.'}
          </p>
          <Button size="sm" className="mt-4 gap-1.5" onClick={() => setShowAdd(true)}>
            <Plus className="h-3.5 w-3.5" /> {items.length === 0 ? 'Pehla stock add karo' : 'Add Stock'}
          </Button>
        </div>
      ) : view === 'table' ? (
        <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <span aria-hidden className="absolute inset-x-0 top-0 z-20 h-[3px] bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500" />
          <div aria-hidden className="pointer-events-none absolute -right-20 -top-28 h-56 w-56 rounded-full bg-orange-500/5 blur-3xl" />
          <div className="relative max-h-[calc(100vh-19rem)] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted/50 backdrop-blur-sm">
                <TableRow className="hover:bg-muted/40">
                  <TableHead className="w-10" />
                  <TableHead>
                    <SortBtn label="Symbol" active={sortBy === 'symbol'} dir={sortDir} onClick={() => cycleSort('symbol')} />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortBtn label="LTP" active={sortBy === 'ltp'} dir={sortDir} onClick={() => cycleSort('ltp')} right />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortBtn label="Day change" active={sortBy === 'pct'} dir={sortDir} onClick={() => cycleSort('pct')} right />
                  </TableHead>
                  <TableHead className="hidden text-right lg:table-cell">
                    <SortBtn label="5m / 10m" active={sortBy === 'm5'} dir={sortDir} onClick={() => cycleSort('m5')} right />
                  </TableHead>
                  <TableHead className="hidden min-w-[150px] xl:table-cell">Day range</TableHead>
                  <TableHead className="hidden text-right md:table-cell">
                    <SortBtn label="Volume" active={sortBy === 'volume'} dir={sortDir} onClick={() => cycleSort('volume')} right />
                  </TableHead>
                  <TableHead className="hidden text-right lg:table-cell">Bid / Ask</TableHead>
                  <TableHead className="w-[132px] text-right">Trade</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((it) => (
                  <RowFragment
                    key={it.instrumentToken}
                    item={it}
                    flash={flash[it.instrumentToken]}
                    fav={favs.has(String(it.instrumentToken))}
                    expanded={expanded === String(it.instrumentToken)}
                    ordering={ordering}
                    qty={qtyByToken[it.instrumentToken] ?? 1}
                    onToggle={() => setExpanded((p) => (p === String(it.instrumentToken) ? null : String(it.instrumentToken)))}
                    onFav={() => toggleFav(String(it.instrumentToken))}
                    onRemove={() => setToRemove(it)}
                    onQty={(q) => setQtyByToken((p) => ({ ...p, [it.instrumentToken]: q }))}
                    onOrder={(s) => void quickOrder(it, s)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="sticky bottom-0 border-t border-border/60 bg-muted/40 px-4 py-2 text-[10px] text-muted-foreground backdrop-blur-sm">
            {visible.length} of {items.length} shown · click row for full OHLC + momentum + trade ticket · /data-saver/watch-list aur /trading/watchlist — same page, same data
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((it) => (
            <WatchCard
              key={it.instrumentToken}
              item={it}
              flash={flash[it.instrumentToken]}
              fav={favs.has(String(it.instrumentToken))}
              expanded={expanded === String(it.instrumentToken)}
              ordering={ordering}
              qty={qtyByToken[it.instrumentToken] ?? 1}
              onToggle={() => setExpanded((p) => (p === String(it.instrumentToken) ? null : String(it.instrumentToken)))}
              onFav={() => toggleFav(String(it.instrumentToken))}
              onRemove={() => setToRemove(it)}
              onQty={(q) => setQtyByToken((p) => ({ ...p, [it.instrumentToken]: q }))}
              onOrder={(s) => void quickOrder(it, s)}
            />
          ))}
        </div>
      )}

      {/* ADD modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm sm:items-center" onClick={() => setShowAdd(false)}>
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-r from-primary/[0.07] to-transparent px-4 py-3">
              <div>
                <h3 className="text-sm font-bold">Add Stock</h3>
                <p className="text-[11px] text-muted-foreground">Real NSE EQ universe se search karo</p>
              </div>
              <button onClick={() => setShowAdd(false)} aria-label="Close" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input autoFocus value={addQuery} onChange={(e) => setAddQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setShowAdd(false)} placeholder="RELIANCE / INFY / token / ISIN…" className="h-10 pl-9" />
                {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 animate-pulse text-[11px] text-muted-foreground">…</span>}
              </div>
              <div className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-border">
                {addQuery.trim().length < 2 ? (
                  <p className="px-4 py-6 text-center text-[11px] text-muted-foreground">Kam se kam 2 characters likho — live instrument search yahin results degi.</p>
                ) : searchStatus === 'error' ? (
                  <p className="px-4 py-6 text-center text-[11px] text-destructive">Search unavailable — thodi der baad retry karo.</p>
                ) : hits.length === 0 && !searching ? (
                  <p className="px-4 py-6 text-center text-[11px] text-muted-foreground">No matching NSE EQ instruments</p>
                ) : (
                  hits.map((h) => {
                    const added = alreadyIn.has(h.token);
                    return (
                      <div key={h.token} className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2.5 last:border-0 hover:bg-muted/40">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-bold">{h.symbol || h.tradingSymbol}</p>
                          <p className="truncate text-[10px] text-muted-foreground">{h.name || '—'}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[9px] text-muted-foreground/70">
                            <Badge variant="outline" className="h-4 px-1 text-[8px]">{(h.instrumentType || h.exchangeSegment || 'EQ').toUpperCase()}</Badge>
                            <span className="tabular-nums">Token {h.token}</span>
                            {h.ltp != null && <span className="font-semibold tabular-nums text-foreground">₹{fmtPrice(h.ltp)}</span>}
                            {h.changePct != null && (
                              <span className={cn('font-semibold tabular-nums', h.changePct > 0 ? 'text-success' : h.changePct < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                                {sign(h.changePct)}{h.changePct.toFixed(2)}%
                              </span>
                            )}
                          </p>
                        </div>
                        <Button size="sm" disabled={added} onClick={() => void addStock(h)} className="h-7 shrink-0 text-[11px]">
                          {added ? 'Added' : '+ Add'}
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* REMOVE modal */}
      {toRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setToRemove(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold">Watchlist se hatayein?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="font-bold text-foreground">{toRemove.symbol}</span> {toRemove.companyName ? `· ${toRemove.companyName}` : ''} ko remove kar diya jayega. Dono pages se हटेगा (same list)।
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setToRemove(null)}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={() => void confirmRemove()}>Remove</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sub: stat

function StatMini({ tone, label, value, sub, icon: Icon, avg }: { tone: 'neutral' | 'success' | 'danger' | 'muted' | 'live' | 'avg'; label: string; value: string; sub: string; icon: React.ElementType; avg?: number | null }) {
  const bar = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-destructive' : tone === 'live' ? 'bg-success' : tone === 'avg' ? (avg != null && avg > 0 ? 'bg-success' : avg != null && avg < 0 ? 'bg-destructive' : 'bg-border') : 'bg-primary';
  const valCls = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-destructive' : tone === 'avg' ? (avg != null && avg > 0 ? 'text-success' : avg != null && avg < 0 ? 'text-destructive' : 'text-foreground') : 'text-foreground';
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[2.5px]', bar)} />
      <div className="flex items-center gap-2.5 p-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground ring-1 ring-inset ring-border/50">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className={cn('truncate text-lg font-bold tabular-nums leading-6', valCls)}>{value}</p>
          <p className="truncate text-[10px] tabular-nums text-muted-foreground">{sub}</p>
        </div>
      </div>
    </div>
  );
}

function SortBtn({ label, active, dir, onClick, right }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; right?: boolean }) {
  return (
    <button onClick={onClick} className={cn('inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider hover:text-foreground', active ? 'text-foreground' : 'text-muted-foreground', right && 'flex-row-reverse')}>
      {label}
      {active ? dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-40" />}
    </button>
  );
}

// ---------------------------------------------------------------- sub: row (table)

function RowFragment({ item, flash, fav, expanded, ordering, qty, onToggle, onFav, onRemove, onQty, onOrder }: {
  item: WatchListItem;
  flash?: 'up' | 'down';
  fav: boolean;
  expanded: boolean;
  ordering: string | null;
  qty: number;
  onToggle: () => void;
  onFav: () => void;
  onRemove: () => void;
  onQty: (q: number) => void;
  onOrder: (s: 'BUY' | 'SELL') => void;
}) {
  const md = item.marketData;
  const c = classify(md.changePct);
  const tone = c === 'gainers' ? 'text-success' : c === 'losers' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <>
      <TableRow
        onClick={onToggle}
        className={cn(
          'group cursor-pointer transition-colors',
          c === 'gainers' && 'bg-success/[0.03] hover:bg-success/[0.06]',
          c === 'losers' && 'bg-destructive/[0.03] hover:bg-destructive/[0.06]',
          flash === 'up' && 'bg-success/[0.09]',
          flash === 'down' && 'bg-destructive/[0.09]',
        )}
      >
        <TableCell className="relative w-10">
          <span
            aria-hidden
            className={cn(
              'absolute inset-y-1 left-0 w-[3px] scale-y-0 rounded-r-full bg-primary transition-transform duration-150 group-hover:scale-y-100',
              c === 'gainers' && 'group-hover:bg-success',
              c === 'losers' && 'group-hover:bg-destructive',
            )}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFav();
            }}
            aria-label="Favourite"
            className="rounded-md p-1 hover:bg-muted"
          >
            <Star className={cn('h-3.5 w-3.5', fav ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/50')} />
          </button>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground/50">{expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
            <span aria-hidden className={cn('h-8 w-[3px] shrink-0 rounded-full', c === 'gainers' ? 'bg-success' : c === 'losers' ? 'bg-destructive' : 'bg-muted-foreground/30')} />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5">
                <span className="truncate text-sm font-bold">{item.symbol || item.tradingSymbol}</span>
                <Badge variant="outline" className="h-4 px-1 text-[8px]">EQ</Badge>
              </p>
              {item.companyName && <p className="max-w-[170px] truncate text-[10px] text-muted-foreground">{item.companyName}</p>}
            </div>
          </div>
        </TableCell>
        <TableCell className="text-right">
          <p className={cn('text-[15px] font-bold tabular-nums leading-5 transition-colors duration-300', flash === 'up' ? 'text-success' : flash === 'down' ? 'text-destructive' : 'text-foreground')}>
            {md.ltp != null ? `₹${fmtPrice(md.ltp)}` : '—'}
          </p>
          <p className="text-[9px] tabular-nums text-muted-foreground">{md.prevClose != null ? `PClose ₹${fmtPrice(md.prevClose)}` : ''}</p>
        </TableCell>
        <TableCell className="text-right">
          <span className={cn('inline-flex flex-col items-end rounded-lg px-2 py-1 tabular-nums', c === 'gainers' ? 'bg-success/10' : c === 'losers' ? 'bg-destructive/10' : 'bg-muted/50')}>
            <span className={cn('text-xs font-bold leading-4', tone)}>{md.change == null ? '—' : `${sign(md.change)}₹${fmtPrice(md.change)}`}</span>
            <span className={cn('text-[11px] font-semibold leading-4', tone)}>{md.changePct == null ? '' : `${sign(md.changePct)}${md.changePct.toFixed(2)}%`}</span>
          </span>
        </TableCell>
        <TableCell className="hidden text-right lg:table-cell">
          <MiniMom m5={md.momentum?.['5m']} m10={md.momentum?.['10m']} />
        </TableCell>
        <TableCell className="hidden xl:table-cell">
          <RangeBar low={md.low} high={md.high} ltp={md.ltp} />
        </TableCell>
        <TableCell className="hidden text-right tabular-nums md:table-cell">
          <p className="text-xs font-semibold text-foreground">{fmtCompact(md.volume)}</p>
          <p className="text-[9px] text-muted-foreground">{md.volume != null ? fmtNumber(md.volume) : ''}</p>
        </TableCell>
        <TableCell className="hidden text-right tabular-nums lg:table-cell">
          <p className="text-[11px] text-foreground">{md.bid != null ? fmtPrice(md.bid) : '—'} <span className="text-muted-foreground">/</span> {md.ask != null ? fmtPrice(md.ask) : '—'}</p>
        </TableCell>
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1 opacity-70 transition-opacity duration-150 group-hover:opacity-100">
            <Button size="sm" className="h-7 bg-success px-2 text-[11px] font-bold text-white hover:bg-success/90" disabled={ordering != null} onClick={() => onOrder('BUY')}>B</Button>
            <Button size="sm" variant="destructive" className="h-7 px-2 text-[11px] font-bold" disabled={ordering != null} onClick={() => onOrder('SELL')}>S</Button>
            <button onClick={onRemove} aria-label={`Remove ${item.symbol}`} className="rounded-md p-1.5 text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={9} className="p-0">
            <ExpandedPanel item={item} ordering={ordering} qty={qty} onQty={onQty} onOrder={onOrder} onRemove={onRemove} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function MiniMom({ m5, m10 }: { m5: number | null | undefined; m10: number | null | undefined }) {
  const chip = (v: number | null | undefined) => (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums', v == null ? 'bg-muted/60 text-muted-foreground/60' : v > 0 ? 'bg-success/10 text-success' : v < 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted/60 text-muted-foreground')}>
      {v == null ? '…' : `${sign(v)}${v.toFixed(1)}%`}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1">
      {chip(m5 ?? null)} {chip(m10 ?? null)}
    </span>
  );
}

function RangeBar({ low, high, ltp }: { low: number | null; high: number | null; ltp: number | null }) {
  if (low == null || high == null || ltp == null || high <= low) return <span className="text-[10px] text-muted-foreground">—</span>;
  const pct = Math.max(0, Math.min(100, ((ltp - low) / (high - low)) * 100));
  return (
    <div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-destructive via-warning to-success" style={{ width: `${pct}%`, opacity: 0.7 }} />
        <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-foreground shadow" style={{ left: `${pct}%` }} />
      </div>
      <p className="mt-1 flex justify-between text-[9px] tabular-nums text-muted-foreground">
        <span>L {fmtPrice(low)}</span>
        <span className="font-semibold text-foreground">{pct.toFixed(0)}%</span>
        <span>H {fmtPrice(high)}</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- sub: expanded

function ExpandedPanel({ item, ordering, qty, onQty, onOrder, onRemove }: {
  item: WatchListItem;
  ordering: string | null;
  qty: number;
  onQty: (q: number) => void;
  onOrder: (s: 'BUY' | 'SELL') => void;
  onRemove: () => void;
}) {
  const md = item.marketData;
  return (
    <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-primary">Instrument</p>
        <DetailRow label="Symbol" value={item.symbol || '—'} />
        <DetailRow label="Company" value={item.companyName ?? '—'} />
        <DetailRow label="Token" value={item.instrumentToken} />
        <DetailRow label="ISIN" value={item.isin ?? '—'} />
        <DetailRow label="Segment" value={String(item.exchangeSegment).toUpperCase()} />
      </div>
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-primary">Price action</p>
        <DetailRow label="LTP" value={md.ltp != null ? `₹${fmtPrice(md.ltp)}` : '—'} bold />
        <DetailRow label="Prev close" value={md.prevClose != null ? `₹${fmtPrice(md.prevClose)}` : '—'} />
        <DetailRow label="Open" value={md.open != null ? `₹${fmtPrice(md.open)}` : '—'} />
        <DetailRow label="High / Low" value={md.high != null ? `₹${fmtPrice(md.high)} / ₹${fmtPrice(md.low ?? 0)}` : '—'} />
        <DetailRow label="Volume" value={md.volume != null ? fmtNumber(md.volume) : '—'} />
        <div className="mt-2"><RangeBar low={md.low} high={md.high} ltp={md.ltp} /></div>
      </div>
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-primary">Momentum</p>
        <div className="flex flex-wrap gap-1.5">
          {WINDOWS.map((k) => {
            const v = md.momentum?.[k] ?? null;
            return (
              <span key={k} className={cn('inline-flex items-center gap-1 rounded-lg border px-1.5 py-1 text-[10px] font-semibold tabular-nums', v == null ? 'border-border text-muted-foreground/50' : v > 0 ? 'border-success/30 bg-success/[0.07] text-success' : v < 0 ? 'border-destructive/30 bg-destructive/[0.07] text-destructive' : 'border-border text-muted-foreground')}>
                {k} <span className="font-bold">{v == null ? '…' : `${sign(v)}${v.toFixed(2)}%`}</span>
              </span>
            );
          })}
        </div>
        <div className="mt-3 border-t border-border/50 pt-2">
          <DetailRow label="Last tick" value={md.lastTickAt ? toIst(md.lastTickAt) : '—'} />
          <DetailRow label="Bid / Ask" value={md.bid != null ? `${fmtPrice(md.bid)} / ${md.ask != null ? fmtPrice(md.ask) : '—'}` : '—'} />
        </div>
      </div>
      <div className="rounded-xl border border-primary/25 bg-gradient-to-b from-primary/[0.06] to-transparent p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-primary">
          <ShoppingCart className="h-3 w-3" /> Quick trade · MIS · MKT
        </p>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Qty</span>
          <Input type="number" min={1} value={qty} onChange={(e) => onQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))} className="h-8 w-20 text-xs tabular-nums" />
          <span className="text-[10px] tabular-nums text-muted-foreground">{md.ltp != null ? `≈ ₹${fmtNumber((md.ltp ?? 0) * qty)}` : ''}</span>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <Button size="sm" className="bg-success font-bold text-white hover:bg-success/90" disabled={ordering != null} onClick={() => onOrder('BUY')}>BUY</Button>
          <Button size="sm" variant="destructive" className="font-bold" disabled={ordering != null} onClick={() => onOrder('SELL')}>SELL</Button>
        </div>
        <button onClick={onRemove} className="mt-2.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive">
          <Trash2 className="h-3 w-3" /> Remove from watchlist
        </button>
      </div>
    </div>
  );
}

function DetailRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-[10px] text-muted-foreground/70">{label}</span>
      <span className={cn('truncate text-right text-[11px] tabular-nums', bold ? 'font-bold text-foreground' : 'font-medium text-foreground')}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------- sub: card view

function WatchCard({ item, flash, fav, expanded, ordering, qty, onToggle, onFav, onRemove, onQty, onOrder }: {
  item: WatchListItem;
  flash?: 'up' | 'down';
  fav: boolean;
  expanded: boolean;
  ordering: string | null;
  qty: number;
  onToggle: () => void;
  onFav: () => void;
  onRemove: () => void;
  onQty: (q: number) => void;
  onOrder: (s: 'BUY' | 'SELL') => void;
}) {
  const md = item.marketData;
  const c = classify(md.changePct);
  return (
    <div className={cn('overflow-hidden rounded-2xl border bg-card shadow-sm transition-all', c === 'gainers' ? 'border-success/30' : c === 'losers' ? 'border-destructive/30' : 'border-border', flash === 'up' && 'ring-2 ring-success/50', flash === 'down' && 'ring-2 ring-destructive/50')}>
      <div onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle())} className={cn('cursor-pointer p-3.5', c === 'gainers' ? 'bg-success/[0.04]' : c === 'losers' ? 'bg-destructive/[0.04]' : '')}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={(e) => (e.stopPropagation(), onFav())} aria-label="Favourite" className="rounded-md p-1 hover:bg-muted">
              <Star className={cn('h-4 w-4', fav ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{item.symbol}</p>
              <p className="max-w-[160px] truncate text-[10px] text-muted-foreground">{item.companyName ?? `Token ${item.instrumentToken}`}</p>
            </div>
          </div>
          <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-bold', c === 'gainers' ? 'bg-success/15 text-success' : c === 'losers' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground')}>
            {c === 'gainers' ? '▲ GAIN' : c === 'losers' ? '▼ LOSS' : '· FLAT'}
          </span>
        </div>
        <div className="mt-2.5 flex items-end justify-between">
          <div>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">LTP</p>
            <p className={cn('text-xl font-bold tabular-nums leading-6', flash === 'up' ? 'text-success' : flash === 'down' ? 'text-destructive' : 'text-foreground')}>{md.ltp != null ? `₹${fmtPrice(md.ltp)}` : '—'}</p>
          </div>
          <div className="text-right">
            <p className={cn('text-sm font-bold tabular-nums', c === 'gainers' ? 'text-success' : c === 'losers' ? 'text-destructive' : 'text-muted-foreground')}>{md.changePct == null ? '—' : `${sign(md.changePct)}${md.changePct.toFixed(2)}%`}</p>
            <p className="text-[11px] tabular-nums text-muted-foreground">{md.change == null ? '' : `${sign(md.change)}₹${fmtPrice(md.change)}`}</p>
          </div>
        </div>
        <div className="mt-2.5"><RangeBar low={md.low} high={md.high} ltp={md.ltp} /></div>
        <div className="mt-2.5 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
          <MiniMom m5={md.momentum?.['5m']} m10={md.momentum?.['10m']} />
          <span>Vol {fmtCompact(md.volume)}</span>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border/60">
          <ExpandedPanel item={item} ordering={ordering} qty={qty} onQty={onQty} onOrder={onOrder} onRemove={onRemove} />
        </div>
      )}
    </div>
  );
}
