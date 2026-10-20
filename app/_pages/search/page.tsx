'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, ChevronDown, History as HistoryIcon, Layers,
  Plus, Search, Settings2, ShoppingCart, Timer, X, Zap,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { backendFetch } from '@/lib/backend';
import { cn } from '@/lib/utils';

/**
 * SERVICES → Search Engine — redesigned from zero (customize + on/off).
 *
 * Doc docs/engines/search-engine.md: Find + Rank + Present + Route. No order
 * execution, no watchlist ownership, no invented margin — handoffs only.
 *
 * Customize (persisted, all on/off):
 *  - Result-card sections: LTP, Change, Volume, Bid/Ask, Tick age, Margin,
 *    Live badge, Rank badge — each independently on/off.
 *  - Request: scopes (multi), Live LTP, 1-Qty Margin, limit, debounce ms.
 * Advance: keyboard nav (↑↓ + Enter expand + Esc clear, doc §9), stale-guard
 * (sequence + abort, doc §16), recent searches, engine status card, CSV.
 */

const PREFS_KEY = 'search-ui:prefs:v1';
const RECENT_KEY = 'search-ui:recent:v1';
const LIVE_STALE_SECONDS = 30;
const SCOPES = ['stocks', 'pages', 'features', 'actions', 'watchlists'] as const;

type ShowPrefs = {
  ltp: boolean; change: boolean; volume: boolean; bidAsk: boolean;
  tickAge: boolean; margin: boolean; live: boolean; rank: boolean;
};

type Prefs = {
  scopes: string[];
  withLive: boolean;
  withMargin: boolean;
  limit: number;
  debounceMs: number;
  show: ShowPrefs;
};

const DEFAULTS: Prefs = {
  scopes: ['stocks'],
  withLive: true,
  withMargin: false,
  limit: 10,
  debounceMs: 200,
  show: { ltp: true, change: true, volume: true, bidAsk: true, tickAge: true, margin: true, live: true, rank: true },
};

const SHOW_LABELS: [keyof ShowPrefs, string][] = [
  ['ltp', 'LTP price'],
  ['change', 'Change ₹ + %'],
  ['volume', 'Volume'],
  ['bidAsk', 'Bid / Ask + spread'],
  ['tickAge', 'Tick age'],
  ['margin', '1-Qty margin'],
  ['live', 'LIVE/STALE badge'],
  ['rank', 'Rank badge'],
];

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULTS,
      ...p,
      show: { ...DEFAULTS.show, ...(p.show ?? {}) },
      scopes: Array.isArray(p.scopes) && p.scopes.length ? p.scopes.filter((s) => (SCOPES as readonly string[]).includes(s)) : DEFAULTS.scopes,
    };
  } catch {
    return DEFAULTS;
  }
}

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN');
}

function fmtPct(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
}

function fmtMargin(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const LIVE_TONE: Record<string, string> = {
  LIVE: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  STALE: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  UNAVAILABLE: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

const MARGIN_TONE: Record<string, string> = {
  AVAILABLE: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  UNAVAILABLE: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
  STALE: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  REQUIRES_ORDER_CONTEXT: 'border-violet-500/40 bg-violet-500/10 text-violet-300',
};

function IstClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Badge variant="outline" className="tabular-nums">IST {now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}</Badge>;
}

export default function SearchPage() {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    setPrefs(loadPrefs());
    try {
      const r = localStorage.getItem(RECENT_KEY);
      if (r) setRecent(JSON.parse(r) as string[]);
    } catch { /* ignore */ }
    setReady(true);
    backendFetch('/api/search/status', { timeoutMs: 10000 }).then((res) => {
      if (res.ok && res.data) setStatus(res.data);
    }).catch(() => { /* status card stays honest-dash */ });
  }, []);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs, ready]);

  const pushRecent = useCallback((qq: string) => {
    const t = qq.trim();
    if (!t) return;
    setRecent((prev) => {
      const next = [t, ...prev.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // doc §16: stale-guard — sequence + abort, latest query always wins
  const doSearch = useCallback(async (qq: string, p?: Prefs) => {
    const cfg = p ?? prefsRef.current;
    const my = ++seq.current;
    abort.current?.abort();
    if (!qq.trim()) {
      setResults([]);
      setMeta(null);
      setActiveIdx(-1);
      return;
    }
    const ctl = new AbortController();
    abort.current = ctl;
    setLoading(true);
    try {
      const fetchP = backendFetch('/api/phase3/search/scoped', {
        method: 'POST',
        body: JSON.stringify({
          query: qq,
          scopes: cfg.scopes,
          limit: cfg.limit,
          with_live: cfg.withLive,
          with_margin: cfg.withMargin,
        }),
      });
      const timeoutP = new Promise((_, rej) => {
        const id = setTimeout(() => rej(new Error('timeout')), 12000);
        ctl.signal.addEventListener('abort', () => { clearTimeout(id); rej(new DOMException('aborted', 'AbortError')); });
      });
      const res = (await Promise.race([fetchP, timeoutP])) as Awaited<ReturnType<typeof backendFetch>>;
      if (my !== seq.current) return; // stale response — never overwrite newer
      if (res.ok && res.data) {
        setResults((res.data as any).results || []);
        setMeta(res.data);
        setActiveIdx(-1);
        pushRecent(qq);
      } else {
        setResults([]);
        setMeta({ error: res.error || `HTTP ${res.status}` });
      }
    } catch (e: unknown) {
      if (my !== seq.current) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setResults([]);
      setMeta({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [pushRecent]);

  const schedule = useCallback((qq: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSearch(qq), Math.max(80, Math.min(800, prefsRef.current.debounceMs)));
  }, [doSearch]);

  const onQuery = (v: string) => {
    setQuery(v);
    setExpanded(null);
    schedule(v);
  };

  const toggleScope = (s: string) => {
    setPrefs((p) => {
      const next = p.scopes.includes(s) ? p.scopes.filter((x) => x !== s) : [...p.scopes, s];
      const cfg = { ...p, scopes: next.length ? next : p.scopes };
      setTimeout(() => void doSearch(query, cfg), 0);
      return cfg;
    });
  };

  const setShow = (k: keyof ShowPrefs, v: boolean) =>
    setPrefs((p) => ({ ...p, show: { ...p.show, [k]: v } }));

  // doc §9: keyboard — ↑↓ move, Enter expands, Esc clears
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setActiveIdx((i) => {
        const n = Math.min(results.length - 1, i + 1);
        document.getElementById(`sr-${n}`)?.scrollIntoView({ block: 'nearest' });
        return n;
      });
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActiveIdx((i) => {
        const n = Math.max(0, i - 1);
        document.getElementById(`sr-${n}`)?.scrollIntoView({ block: 'nearest' });
        return n;
      });
    } else if (e.key === 'Enter' && activeIdx >= 0 && results[activeIdx]) {
      const r = results[activeIdx];
      const id = String(r.id ?? r.symbol ?? activeIdx);
      setExpanded((x) => (x === id ? null : id));
    } else if (e.key === 'Escape') {
      setQuery('');
      setResults([]);
      setMeta(null);
      setActiveIdx(-1);
      setExpanded(null);
    }
  };

  // doc §10: BUY/SELL never executes — OPEN_ORDER intent handoff to order panel
  const orderIntent = (r: any, side: 'BUY' | 'SELL') => {
    const intent = {
      type: 'OPEN_ORDER',
      symbol: r.symbol ?? r.tradingSymbol ?? '',
      token: String(r.token ?? ''),
      exchange: r.exchange ?? 'NSE',
      side,
      source: 'SEARCH',
    };
    try { sessionStorage.setItem('search:order-intent', JSON.stringify(intent)); } catch { /* ignore */ }
    setNotice({ kind: 'ok', text: `${side} ${intent.symbol} intent → order panel me confirm karo (no direct execution).` });
    router.push('/trading/trade');
  };

  // doc §11: Add to Watchlist handoff — real POST, never ownership
  const addWatch = async (r: any) => {
    const id = String(r.id ?? r.symbol);
    setActing(`add-${id}`);
    try {
      const res = await fetch('/api/phase2/watch-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: r.symbol,
          instrumentToken: String(r.token ?? ''),
          exchangeSegment: r.exchangeSegment ?? 'nse_cm',
          isin: r.isin ?? null,
          companyName: r.name ?? null,
          tradingSymbol: r.tradingSymbol ?? null,
        }),
      });
      const d = await res.json().catch(() => ({}));
      setNotice(res.ok && d.ok ? { kind: 'ok', text: `${r.symbol} watchlist me add hua.` } : { kind: 'err', text: d.error ?? 'Add failed' });
    } catch {
      setNotice({ kind: 'err', text: 'Network error — add nahi hua.' });
    }
    setActing(null);
  };

  // doc §12: Open in Market Watch — deep link, ranking MW engine ke paas
  const openMW = (r: any) => {
    if (!r.symbol) return;
    router.push(`/services/market-watch?search=${encodeURIComponent(r.symbol)}`);
  };

  const exportCsv = () => {
    if (!results.length) return;
    const head = 'type,symbol,name,exchange,token,ltp,change,changePct,volume,margin,liveStatus\n';
    const body = results.map((r: any) => [r.type ?? '', r.symbol ?? '', `"${String(r.name ?? '').replace(/"/g, '""')}"`, r.exchange ?? '', r.token ?? '', r.ltp ?? '', r.change ?? '', r.changePct ?? '', r.volume ?? '', r.oneQtyMargin ?? '', r.liveStatus ?? ''].join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([head + body], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'search-results.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const show = prefs.show;
  const tookMs = meta?.tookMs;
  const metrics = status?.metrics?.custom ?? {};
  const zeroRate = Number(metrics.searchCount) > 0 ? (Number(metrics.zeroResultCount ?? 0) / Number(metrics.searchCount)) * 100 : null;
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of results) m[String(r.type ?? 'unknown')] = (m[String(r.type ?? 'unknown')] ?? 0) + 1;
    return m;
  }, [results]);

  return (
    <div className="space-y-4 pb-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.12] via-primary/[0.06] to-cyan-500/[0.12]" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-indigo-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-cyan-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-primary to-cyan-500 text-white shadow-xl">
            <Search className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Search Engine</h1>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground sm:text-sm">
              {prefs.scopes.join(', ')} · v{status?.version ?? '2.0.0'} · {fmtNum(metrics.instrumentCount)} instruments indexed
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={loading ? 'border border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : results.length ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-border text-muted-foreground'}>
              {loading ? 'Searching…' : results.length ? `${meta?.total ?? results.length} results` : query ? 'No results' : 'Idle'}
            </Badge>
            {notice && <Badge variant="outline" className={notice.kind === 'ok' ? 'border-emerald-500/40 text-emerald-300' : 'border-rose-500/40 text-rose-300'}>{notice.text}</Badge>}
            <IstClock />
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!results.length}>CSV</Button>
            <Button size="sm" onClick={() => setCustomize((v) => !v)} className="gap-1.5 bg-gradient-to-r from-indigo-500 to-cyan-500 shadow-md">
              <Settings2 className="h-3.5 w-3.5" /> {customize ? 'Hide' : 'Customize'}
            </Button>
          </div>
        </div>
      </div>

      {meta?.error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0">Search failed: {meta.error}{meta.errorCode ? ` (${meta.errorCode})` : ''}</span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => void doSearch(query)}>Retry</Button>
        </div>
      )}

      {/* KPI STRIP */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          { icon: Search, label: 'Results', value: String(meta?.total ?? results.length), sub: `${prefs.scopes.join(', ')} · limit ${prefs.limit}`, bar: 'bg-indigo-400', chip: 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg', tone: '' },
          { icon: Timer, label: 'Latency', value: tookMs != null ? `${Number(tookMs).toFixed(1)} ms` : '—', sub: prefs.withLive ? 'with live LTP' : 'live off', bar: 'bg-cyan-400', chip: 'bg-gradient-to-br from-cyan-500 to-sky-600 text-white shadow-lg', tone: '' },
          { icon: Layers, label: 'Index', value: fmtNum(metrics.instrumentCount), sub: `${fmtNum(metrics.indexedTerms)} terms · cache ${fmtNum(metrics.ltpCacheSize)}`, bar: 'bg-emerald-400', chip: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg', tone: '' },
          { icon: Zap, label: 'Zero-rate', value: zeroRate != null ? `${zeroRate.toFixed(1)}%` : '—', sub: `${fmtNum(metrics.searchCount)} searches · stale-rej ${fmtNum(metrics.staleRejected)}`, bar: 'bg-amber-400', chip: 'bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg', tone: '' },
        ] as const).map((k) => (
          <Card key={k.label} className="relative overflow-hidden shadow-soft transition-all duration-200 hover:-translate-y-0.5">
            <span aria-hidden className={cn('absolute inset-x-0 top-0 h-1', k.bar)} />
            <CardContent className="flex items-center gap-3 p-3.5">
              <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', k.chip)}><k.icon className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
                <p className="truncate font-mono text-lg font-bold tabular-nums leading-7" title={String(k.value)}>{k.value}</p>
                <p className="truncate text-[11px] text-muted-foreground" title={k.sub}>{k.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* SEARCH CARD */}
      <Card className="overflow-hidden border-indigo-500/25 shadow-soft">
        <CardContent className="space-y-3 p-4" onKeyDown={onKeyDown}>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search stocks, pages, features… (reliance, market watch, buy)"
              className="h-11 pl-10 pr-24 text-sm"
              aria-label="Search query"
            />
            <span className="absolute right-2.5 top-1/2 hidden -translate-y-1/2 gap-1 sm:flex">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">↑↓</kbd>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Enter</kbd>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Esc</kbd>
            </span>
            {query && (
              <button onClick={() => onQuery('')} aria-label="Clear search" className="absolute right-16 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground sm:right-24">
                <X className="h-4 w-4" />
              </button>
            )}
            {loading && <span className="absolute right-3 top-1/2 hidden -translate-y-1/2 animate-pulse text-[11px] text-muted-foreground">…</span>}
          </div>

          {/* scopes on/off */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Scopes</span>
            {SCOPES.map((s) => {
              const on = prefs.scopes.includes(s);
              return (
                <button key={s} onClick={() => toggleScope(s)} aria-pressed={on}
                  className={cn('rounded-full border px-3 py-1.5 text-xs font-semibold capitalize transition-all', on ? 'border-indigo-500/50 bg-indigo-500/15 text-foreground shadow-sm' : 'border-border text-muted-foreground hover:text-foreground')}>
                  {s}
                </button>
              );
            })}
            <span className="ml-auto flex items-center gap-3 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5">
                <Switch checked={prefs.withLive} onCheckedChange={(v) => { setPrefs((p) => ({ ...p, withLive: v })); setTimeout(() => void doSearch(query, { ...prefsRef.current, withLive: v }), 0); }} />
                Live LTP
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <Switch checked={prefs.withMargin} onCheckedChange={(v) => { setPrefs((p) => ({ ...p, withMargin: v })); setTimeout(() => void doSearch(query, { ...prefsRef.current, withMargin: v }), 0); }} />
                1-Qty Margin
              </label>
              <label className="flex items-center gap-1.5 text-muted-foreground">Limit
                <select value={prefs.limit} onChange={(e) => { const v = Number(e.target.value); setPrefs((p) => ({ ...p, limit: v })); setTimeout(() => void doSearch(query, { ...prefsRef.current, limit: v }), 0); }}
                  className="rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs">
                  {[5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="hidden items-center gap-1.5 text-muted-foreground md:flex">Debounce
                <select value={prefs.debounceMs} onChange={(e) => setPrefs((p) => ({ ...p, debounceMs: Number(e.target.value) }))}
                  className="rounded-lg border border-input bg-background px-2 py-1 font-mono text-xs">
                  {[120, 200, 300, 500].map((n) => <option key={n} value={n}>{n}ms</option>)}
                </select>
              </label>
            </span>
          </div>

          {/* customize: card-section on/off */}
          {customize && (
            <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/[0.04] p-3">
              <div className="mb-2 flex items-center gap-2">
                <Settings2 className="h-3.5 w-3.5 text-indigo-300" />
                <p className="text-xs font-bold">Result card sections — har ek on/off</p>
                <Button size="sm" variant="ghost" className="ml-auto h-6 text-[11px]" onClick={() => setPrefs((p) => ({ ...p, show: { ...DEFAULTS.show } }))}>Reset defaults</Button>
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {SHOW_LABELS.map(([k, label]) => (
                  <label key={k} className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs', show[k] ? 'border-indigo-500/40 bg-indigo-500/10' : 'border-border text-muted-foreground')}>
                    <span>{label}</span>
                    <Switch checked={show[k]} onCheckedChange={(v) => setShow(k, v)} aria-label={label} />
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* recent */}
          {recent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
              {recent.map((r) => (
                <button key={r} onClick={() => { setQuery(r); void doSearch(r); }} className="rounded-full border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-indigo-500/40 hover:text-foreground">
                  {r}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* RESULTS */}
      <Card className="overflow-hidden shadow-soft">
        <CardHeader className="bg-gradient-to-r from-indigo-500/10 to-cyan-500/5 pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-600 p-1.5 text-white shadow"><Search className="h-3.5 w-3.5" /></span>
            Results · stock cards with handoffs
            {meta && (
              <span className="ml-auto flex items-center gap-1.5 font-normal">
                <span className="font-mono tabular-nums text-muted-foreground">{meta.total ?? results.length} hits</span>
                {tookMs != null && <Badge variant="outline" className="tabular-nums">{Number(tookMs).toFixed(1)} ms</Badge>}
                {Object.entries(counts).map(([t, n]) => <Badge key={t} variant="outline" className="tabular-nums">{t} {n}</Badge>)}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 p-3">
          {loading && results.length === 0 && (
            <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted/60" />)}</div>
          )}
          {!loading && !results.length && query && !meta?.error && (
            <div className="py-8 text-center">
              <p className="text-sm font-semibold">No results for “{query}”</p>
              <p className="mt-1 text-xs text-muted-foreground">Symbol, company, token ya ISIN try karo · scope badlo · zero-rate {zeroRate != null ? `${zeroRate.toFixed(1)}%` : '—'}</p>
            </div>
          )}
          {!loading && !results.length && !query && (
            <div className="py-8 text-center">
              <p className="text-sm font-semibold text-muted-foreground">Type to search</p>
              <p className="mt-1 text-xs text-muted-foreground">Stocks, pages, features, actions, watchlists — ↑↓ navigate, Enter expand, Esc clear</p>
            </div>
          )}
          {results.map((r: any, i: number) => {
            const id = String(r.id ?? r.symbol ?? r.name ?? i);
            const isOpen = expanded === id;
            const isActive = activeIdx === i;
            const liveStatus = r.liveStatus ?? 'UNAVAILABLE';
            const marginStatus = r.marginStatus ?? 'UNAVAILABLE';
            const chg = r.change;
            const chgUp = chg != null && Number(chg) > 0;
            const chgDown = chg != null && Number(chg) < 0;
            const isStock = (r.type ?? 'stock') === 'stock';
            return (
              <div key={id} id={`sr-${i}`}
                className={cn('overflow-hidden rounded-xl border bg-card transition-all',
                  liveStatus === 'LIVE' ? 'border-emerald-500/30' : liveStatus === 'STALE' ? 'border-amber-500/30' : 'border-border',
                  isActive && 'ring-2 ring-indigo-500/60',
                  isOpen && 'shadow-soft-lg')}>
                <button onClick={() => setExpanded(isOpen ? null : id)} className="flex w-full flex-wrap items-center gap-2 p-3 text-left" aria-expanded={isOpen}>
                  <span aria-hidden className={cn('h-10 w-1 shrink-0 rounded-full', liveStatus === 'LIVE' ? 'bg-emerald-400' : liveStatus === 'STALE' ? 'bg-amber-400' : 'bg-muted-foreground/30')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-bold">{r.symbol ?? r.name ?? '—'}</span>
                      {r.type && r.type !== 'stock' && <Badge variant="outline" className="font-mono text-[9px]">{r.type}</Badge>}
                      {show.live && <Badge variant="outline" className={cn('font-mono text-[9px]', LIVE_TONE[liveStatus] ?? '')}>{liveStatus}</Badge>}
                      {isStock && show.margin && <Badge variant="outline" className={cn('font-mono text-[9px]', MARGIN_TONE[marginStatus] ?? '')}>{marginStatus}</Badge>}
                      {show.rank && r._score != null && <Badge variant="outline" className="font-mono text-[9px]">rank {String(Array.isArray(r._score) ? r._score[0] : r._score)}</Badge>}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{r.name && r.symbol ? r.name : r.exchange ?? ''}{r.exchange && r.name ? ` · ${r.exchange}` : ''}</span>
                  </span>
                  {isStock && show.ltp && r.ltp != null && (
                    <span className="text-right">
                      <span className="block font-mono text-base font-bold tabular-nums">₹{Number(r.ltp).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      {show.change && (r.changePct != null || r.change != null) && (
                        <span className={cn('block font-mono text-[11px] font-semibold tabular-nums', chgUp ? 'text-emerald-300' : chgDown ? 'text-rose-300' : 'text-muted-foreground')}>
                          {r.change != null ? `${Number(r.change) >= 0 ? '+' : ''}${Number(r.change).toFixed(2)} ` : ''}{r.changePct != null ? fmtPct(r.changePct) : ''}
                        </span>
                      )}
                    </span>
                  )}
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                </button>

                {isOpen && (
                  <div className="space-y-2.5 border-t border-border/50 p-3" onClick={(e) => e.stopPropagation()}>
                    {/* market strip */}
                    {isStock && (
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                        {show.volume && <Mini label="Volume" value={fmtNum(r.volume)} />}
                        {show.bidAsk && <Mini label="Bid / Ask" value={r.bid != null ? `₹${Number(r.bid).toFixed(2)} / ₹${Number(r.ask ?? 0).toFixed(2)}` : '—'} />}
                        {show.bidAsk && <Mini label="Spread" value={r.spread != null ? `₹${Number(r.spread).toFixed(2)}` : '—'} />}
                        {show.tickAge && <Mini label="Tick age" value={r.tickAgeSeconds != null ? `${Number(r.tickAgeSeconds).toFixed(1)}s${Number(r.tickAgeSeconds) > LIVE_STALE_SECONDS ? ' · stale' : ''}` : '—'} />}
                        {show.margin && <Mini label="1-Qty margin" value={fmtMargin(r.oneQtyMargin)} sub={r.marginReason ?? r.marginStatus} />}
                        <Mini label="Token" value={String(r.token ?? '—')} />
                        <Mini label="ISIN" value={r.isin ?? '—'} />
                        <Mini label="Segment" value={String(r.exchangeSegment ?? r.exchange ?? '—').toUpperCase()} />
                      </div>
                    )}
                    {!isStock && (
                      <p className="truncate text-xs text-muted-foreground">{r.detail ?? r.description ?? r.href ?? r.url ?? r.type}</p>
                    )}
                    {/* handoffs — doc §10/11/12: intent only, never execution/ownership */}
                    <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {isStock && (
                        <>
                          <Button size="sm" className="h-7 bg-gradient-to-r from-emerald-500 to-emerald-600 text-xs font-bold text-white" onClick={() => orderIntent(r, 'BUY')}>
                            <ShoppingCart className="mr-1 h-3 w-3" /> BUY
                          </Button>
                          <Button size="sm" variant="destructive" className="h-7 text-xs font-bold" onClick={() => orderIntent(r, 'SELL')}>SELL</Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={acting === `add-${id}`} onClick={() => void addWatch(r)}>
                            <Plus className="mr-1 h-3 w-3" /> Watchlist
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openMW(r)}>Market Watch</Button>
                        </>
                      )}
                      {!isStock && (r.href ?? r.url) && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => router.push(String(r.href ?? r.url))}>Open</Button>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground">intent handoff only — order panel confirms</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Engine: <span className="font-mono">GET /api/search?q= · /suggest · /status</span> + scoped POST — canonical index, deterministic rank, stale-guard. Margin sirf broker provider se, missing = unavailable. Prefs + recent isi browser me saved.
      </p>
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-white/[0.02] px-2 py-1.5">
      <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-xs font-semibold tabular-nums" title={value}>{value}</p>
      {sub != null && <p className="truncate font-mono text-[9px] text-muted-foreground" title={sub}>{sub}</p>}
    </div>
  );
}
