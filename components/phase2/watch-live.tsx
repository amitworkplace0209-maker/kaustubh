'use client';

// Data Saver — Live Watch (rebuilt from scratch, glass-free).
//
// LOOK — "punchy", deliberately NOT glass:
// Solid opaque cards with heavy sign-tinted rails (emerald up / rose down),
// full-colour filled chips, big bold numbers, ds-lift hover, ds-rise stagger
// (transform/opacity only) and a breathing LIVE dot. No backdrop blur, no
// translucent glass anywhere. Reduced-motion users get every effect disabled
// by the global prefers-reduced-motion guard.
//
// DATA — TWO LANES, ONE TRUTH (backend → engine → UI):
//  · REST (always on): /api/market-watch/scan — the FULL NSE EQ universe
//    (thousands of scrip-master rows) built by services/market_scan.py from
//    the ONE live tick store (tick_buffer). 1m/5m/10m changes are REAL
//    window-boundary maths (services read the price history, never guess).
//  · WebSocket (primary for the summary): the backend pushes `watch_scan`
//    snapshots (indexes / breadth / movers / feed meta) the moment membership
//    or counts change — rows keep riding REST, and per-stock ticks ride the
//    `market_watch` instrument channel for what is on screen (cap 120).
//
// HONESTY: a value no feed has produced stays "—". Nothing is invented — not
// by WS, not by REST, not by the UI. Feed idle (market closed / cold boot)
// explains itself instead of showing fake zeros.
//
// CONTENT: header (transport + install) → index strip → breadth bar → gainer/
// loser strips (window-aware) → pinned live detail cards → filter bar
// (price ₹ / %, side, window, search, ≥1% movers) → stock card grid →
// scan provenance footer.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowUpRight, Gauge, Layers, ListPlus, Pause, Play,
  RefreshCw, Search, Smartphone, Sparkles, Star, TrendingDown, TrendingUp, Wifi, WifiOff, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState, fmtCompact, fmtNumber, fmtPrice } from '@/components/design-system';
import { cn } from '@/lib/utils';
import { useFrontendRealtime } from '@/components/frontend-realtime-provider';
import { RealtimeChannelSpec } from '@/lib/realtime-ws';
import { Input } from '@/components/ui/input';

const DASH = '—';
const SCAN_URL = '/api/market-watch/scan';
const PINS_URL = '/api/market-watch/pins';

const REST_POLL_MS = 12_000;      // rows + full doc (universe of thousands)
const WS_SUMMARY_TTL_MS = 45_000; // a stale WS summary yields back to REST values
const OVERLAY_CAP = 120;          // per-stock instrument subscriptions on screen
const RENDER_PAGE = 220;          // cards per page (Show-more pagination)

/* ========================================================================== */
/* Types (the market_scan.py document contract)                                */
/* ========================================================================== */

type ScanRow = {
  token: string; symbol: string; name: string; segment: string;
  ltp: number | null; prevClose: number | null;
  dayChange: number | null; dayChangePct: number | null;
  open: number | null; high: number | null; low: number | null;
  volume: number | null; bid: number | null; ask: number | null;
  tickAgeSec: number | null; status: 'live' | 'stale' | 'no_data';
  pct1m: number | null; chg1m: number | null;
  pct5m: number | null; chg5m: number | null;
  pct10m: number | null; chg10m: number | null;
};

type IndexRow = {
  name: string; token: string;
  ltp: number | null; dayChange: number | null; dayChangePct: number | null;
  volume: number | null; ticks: number | null;
  quality: string; lastTickAt: string | null;
};

type MoverRow = {
  token: string; symbol: string; name: string;
  ltp: number | null; dayChangePct: number | null; dayChange: number | null;
  strip: string; stripPct: number | null; stripChg: number | null;
};

type ScanDoc = {
  generatedAt: string;
  scan: {
    generatedAt?: string; cadenceSeconds?: number; cycleMs?: number;
    universeSize?: number; liveTokens?: number; historyDepthSeconds?: number | null;
    newestTickAgeSec?: number | null; feed?: string; source?: string;
  };
  indexes: IndexRow[];
  breadth: {
    measurable: number; noPrevClose: number; advances: number; declines: number; unchanged: number;
    pct1Up: number; pct1Down: number; pct2Up: number; pct2Down: number;
    pct3Up: number; pct3Down: number; pct5Up: number; pct5Down: number;
  };
  windows: Record<string, { measurable: number; up1: number; down1: number }>;
  movers: Record<string, MoverRow[]>;
  rows?: ScanRow[];
};

const WINDOW_LABELS = ['1m', '5m', '10m'] as const;
type WindowSel = 'day' | '1m' | '5m' | '10m';

const pctKey = (w: Exclude<WindowSel, 'day'>): keyof ScanRow => (w === '1m' ? 'pct1m' : w === '5m' ? 'pct5m' : 'pct10m');
const chgKey = (w: Exclude<WindowSel, 'day'>): keyof ScanRow => (w === '1m' ? 'chg1m' : w === '5m' ? 'chg5m' : 'chg10m');
const pctOf = (r: ScanRow, w: WindowSel): number | null =>
  w === 'day' ? r.dayChangePct : (r[pctKey(w)] as number | null);
const chgOf = (r: ScanRow, w: WindowSel): number | null =>
  w === 'day' ? r.dayChange : (r[chgKey(w)] as number | null);
const moversKey = (w: WindowSel): { up: string; down: string } =>
  w === 'day' ? { up: 'dayUpPct', down: 'dayDownPct' } : { up: `m${w}Up`, down: `m${w}Down` };

/* ========================================================================== */
/* PWA — the same real install surface the dashboard page uses                  */
/* ========================================================================== */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function InstallAppButton() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (isStandalone()) setDone(true);
    const onPrompt = (e: Event) => { e.preventDefault(); setEvent(e as BeforeInstallPromptEvent); };
    const onInstalled = () => { setDone(true); setEvent(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (done || !event) return null;
  return (
    <Button size="sm" variant="ghost"
      onClick={() => { void event.prompt().finally(() => setEvent(null)); }}
      className="rounded-full border border-emerald-400/30 bg-emerald-500/10 text-[11px] font-semibold text-emerald-600 transition hover:bg-emerald-500/20 dark:text-emerald-400"
      aria-label="Install the Data Saver app"
    >
      <Smartphone className="h-3.5 w-3.5" /> Install app
    </Button>
  );
}

/* ========================================================================== */
/* Hooks — dual-lane scan document, server pins, per-token tick overlay         */
/* ========================================================================== */

function useScanDocument(paused: boolean) {
  const { subscribe, onFrame, connected } = useFrontendRealtime();
  const [restDoc, setRestDoc] = useState<ScanDoc | null>(null);
  const [wsDoc, setWsDoc] = useState<ScanDoc | null>(null);
  const [wsAt, setWsAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const pull = useCallback(async () => {
    try {
      const res = await fetch(`${SCAN_URL}?refresh=0`, { cache: 'no-store' });
      const body = await res.json();
      if (body?.data?.scan) {
        setRestDoc(body.data as ScanDoc);
        setError(null);
      } else {
        setError(body?.error || body?.detail || 'scan unavailable');
      }
    } catch {
      setError('scan request failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    void pull();
    const id = setInterval(() => { if (alive && document.visibilityState !== 'hidden') void pull(); }, REST_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [pull, paused]);

  // WS lane: push-driven summary (indexes / breadth / movers / feed meta).
  useEffect(() => {
    if (paused) return;
    void subscribe([{ channel: 'watch_scan' }]).catch(() => {});
  }, [subscribe, paused]);

  useEffect(() => onFrame((frame) => {
    const payload = frame?.data?.payload ?? frame?.data;
    if (frame?.type === 'watch_scan.snapshot' && payload?.scan) {
      setWsDoc(payload as ScanDoc);
      setWsAt(Date.now());
    }
  }), [onFrame]);

  const doc = useMemo<ScanDoc | null>(() => {
    const wsFresh = wsDoc && Date.now() - wsAt < WS_SUMMARY_TTL_MS ? wsDoc : null;
    if (!restDoc) return wsFresh;
    if (!wsFresh) return restDoc;
    // WS wins for everything it carries; rows still ride REST.
    return { ...restDoc, ...wsFresh, rows: restDoc.rows ?? wsFresh.rows };
  }, [restDoc, wsDoc, wsAt]);

  const transport: 'live' | 'poll' | 'none' =
    connected && wsDoc && Date.now() - wsAt < WS_SUMMARY_TTL_MS ? 'live' : (doc ? 'poll' : 'none');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${SCAN_URL}?refresh=1`, { cache: 'no-store' });
      const body = await res.json();
      if (body?.data?.scan) { setRestDoc(body.data as ScanDoc); setError(null); }
    } catch { setError('refresh failed'); }
  }, []);

  return { doc, loading, error, transport, refresh };
}

type Pin = { token: string; symbol: string; name: string };

function usePins() {
  const [pins, setPins] = useState<Map<string, Pin>>(new Map());
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(PINS_URL, { cache: 'no-store' });
      const body = await res.json();
      const map = new Map<string, Pin>();
      for (const p of body?.manual ?? []) {
        const key = String(p?.token ?? p?.instrumentToken ?? '');
        if (key) map.set(key, { token: key, symbol: String(p.symbol || ''), name: String(p.name || '') });
      }
      setPins(map);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = useCallback(async (token: string, symbol: string) => {
    // Optimistic, then reconcile with the server's day-scoped truth.
    setPins((prev) => new Map(prev).set(token, { token, symbol, name: '' }));
    try {
      await fetch(PINS_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: symbol || token }),
      });
    } catch { /* keep optimistic pin; server truth refreshes on next poll */ }
    void load();
  }, [load]);

  const remove = useCallback(async (token: string) => {
    setPins((prev) => { const next = new Map(prev); next.delete(token); return next; });
    try {
      await fetch(`${PINS_URL}/${encodeURIComponent(token)}`, { method: 'DELETE' });
    } catch { /* reconcile below */ }
    void load();
  }, [load]);

  const toggle = useCallback((token: string, symbol: string) => {
    if (pins.has(token)) void remove(token); else void add(token, symbol);
  }, [pins, add, remove]);

  return { pins, loaded, toggle, reload: load };
}

/** Rows currently rendered paginated — those get live per-token overlays. */
function useTokenOverlay(tokens: string[]) {
  const { subscribe, ticks } = useFrontendRealtime();
  const key = tokens.slice(0, OVERLAY_CAP).join(',');
  useEffect(() => {
    if (!key) return;
    const specs: RealtimeChannelSpec[] = key.split(',').map((t) => ({
      channel: 'market_watch',
      instruments: [{ exchange_segment: 'nse_cm', instrument_token: t }],
    }));
    void subscribe(specs).catch(() => {});
  }, [subscribe, key]);
  return ticks;
}

/** Apply a REAL live tick onto a scan row — never fabricate a missing value. */
function overlayRow(row: ScanRow, tick: { ltp?: number | null; netChange?: number | null; netChangePct?: number | null; volume?: number | null } | undefined): ScanRow {
  if (!tick || tick.ltp == null) return row;
  const ltp = tick.ltp;
  const chg = tick.netChange != null
    ? tick.netChange
    : (row.prevClose != null && row.prevClose !== 0 ? ltp - row.prevClose : null);
  const pct = tick.netChangePct != null
    ? tick.netChangePct
    : (chg != null && row.prevClose ? (chg / row.prevClose) * 100 : null);
  return {
    ...row,
    ltp,
    dayChange: chg,
    dayChangePct: pct,
    volume: tick.volume ?? row.volume,
    tickAgeSec: 0,
    status: 'live',
  };
}

/* ========================================================================== */
/* Punchy primitives (SOLID — blur-free, colour-forward)                        */
/* ========================================================================== */

const CHIP: Record<'up' | 'down' | 'flat' | 'none', string> = {
  up: 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950',
  down: 'bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950',
  flat: 'bg-slate-500 text-white dark:bg-slate-400 dark:text-slate-950',
  none: 'bg-muted text-muted-foreground border border-dashed border-border',
};

function tone(v: number | null): 'up' | 'down' | 'flat' | 'none' {
  if (v == null || !Number.isFinite(v)) return 'none';
  if (v > 0) return 'up';
  if (v < 0) return 'down';
  return 'flat';
}

/** Change chip: value or an honest dash inside a muted dashed chip. */
function ChgChip({ pct, className, suffix = '%' }: { pct: number | null; className?: string; suffix?: string }) {
  const t = tone(pct);
  return (
    <span className={cn(
      'inline-flex items-center rounded-lg px-2 py-0.5 text-[11px] font-bold tabular-nums shadow-sm',
      CHIP[t], className,
    )}>
      {pct == null ? DASH : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}${suffix ? suffix : ''}`}
    </span>
  );
}

function RupeeChip({ v, className }: { v: number | null; className?: string }) {
  const t = tone(v);
  return (
    <span className={cn(
      'inline-flex items-center rounded-lg px-2 py-0.5 text-[11px] font-bold tabular-nums shadow-sm',
      CHIP[t], className,
    )}>
      {v == null ? DASH : `${v > 0 ? '+' : ''}₹${Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(2)}`}
    </span>
  );
}

function TransportPill({ transport }: { transport: 'live' | 'poll' | 'none' }) {
  const map = {
    live: { label: 'LIVE · WS push', cls: 'bg-emerald-600 text-white shadow-emerald-600/30 dark:bg-emerald-500' },
    poll: { label: 'REST poll', cls: 'bg-amber-500 text-white shadow-amber-500/30' },
    none: { label: 'offline', cls: 'bg-muted text-muted-foreground' },
  } as const;
  const s = map[transport];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-extrabold tracking-wide shadow-md', s.cls)}>
      <span className={cn('h-1.5 w-1.5 rounded-full bg-white/90', transport === 'live' && 'ds-breathe')} />
      {s.label}
      {transport === 'poll' && <Wifi className="h-3 w-3" />}
      {transport === 'none' && <WifiOff className="h-3 w-3" />}
    </span>
  );
}

/** Solid punchy card: sign rail, staggered rise, hover lift. Zero blur. */
function PunchCard({ sign, index, children, className, id }: {
  sign: 'up' | 'down' | 'flat' | 'none'; index?: number; children: React.ReactNode; className?: string; id?: string;
}) {
  const rail = sign === 'up' ? 'before:bg-emerald-500'
    : sign === 'down' ? 'before:bg-rose-500'
    : sign === 'flat' ? 'before:bg-slate-400'
    : 'before:bg-transparent';
  return (
    <div
      id={id}
      style={index != null ? ({ '--ds-i': index % 12 } as React.CSSProperties) : undefined}
      className={cn(
        'ds-card ds-lift group relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_2px_6px_hsl(var(--foreground)/0.05),0_16px_40px_-24px_hsl(var(--foreground)/0.22)]',
        index != null && 'ds-rise',
        'before:absolute before:inset-y-1.5 before:left-0 before:w-[5px] before:rounded-full before:content-[""]',
        rail,
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ========================================================================== */
/* Sections                                                                    */
/* ========================================================================== */

function IndexCard({ ix, index }: { ix: IndexRow; index: number }) {
  const t = tone(ix.dayChangePct);
  const unavailable = !ix.ltp && ix.ltp !== 0;
  return (
    <PunchCard sign={t} index={index} className={cn('min-w-[210px] max-w-[240px] shrink-0 snap-start p-4', unavailable && 'opacity-80')}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">{ix.name || 'INDEX'}</span>
        <span className={cn(
          'h-2 w-2 rounded-full',
          ix.quality === 'OK' ? 'bg-emerald-500 ds-breathe' : ix.quality && ix.quality !== 'UNAVAILABLE' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600',
        )} title={`quality ${ix.quality || DASH}`} />
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-2xl font-black tabular-nums leading-none">
          {ix.ltp == null ? <span className="text-muted-foreground">{DASH}</span> : fmtNumber(ix.ltp)}
        </span>
        <ChgChip pct={ix.dayChangePct} />
      </div>
      <div className="mt-1 text-[11px] font-semibold tabular-nums text-muted-foreground">
        {ix.dayChange == null ? DASH : `${ix.dayChange > 0 ? '+' : ''}${fmtNumber(ix.dayChange)} pts`}
        <span className="mx-1.5 opacity-40">·</span>
        {ix.lastTickAt ? ix.lastTickAt.slice(11, 19) : DASH}
      </div>
    </PunchCard>
  );
}

function BreadthBar({ breadth }: { breadth: ScanDoc['breadth'] | null }) {
  if (!breadth) return null;
  const total = (breadth.advances ?? 0) + (breadth.declines ?? 0) + (breadth.unchanged ?? 0);
  const w = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '0%');
  return (
    <PunchCard sign="none" className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-extrabold uppercase tracking-wider text-muted-foreground">Market breadth (day)</span>
        <span className="text-[11px] font-bold tabular-nums text-muted-foreground">
          {breadth.measurable > 0 ? `${fmtCompact(breadth.measurable)} measured` : DASH}
        </span>
      </div>
      <div className="mt-2.5 flex h-3 overflow-hidden rounded-full bg-muted/70 ring-1 ring-border/60">
        <span className="bg-emerald-500 transition-all duration-700" style={{ width: w(breadth.advances) }} />
        <span className="bg-slate-400/80 transition-all duration-700" style={{ width: w(breadth.unchanged) }} />
        <span className="bg-rose-500 transition-all duration-700" style={{ width: w(breadth.declines) }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold tabular-nums">
        <span className="text-emerald-600 dark:text-emerald-400">▲ {breadth.advances} advances</span>
        <span className="text-rose-600 dark:text-rose-400">▼ {breadth.declines} declines</span>
        <span className="text-muted-foreground">● {breadth.unchanged} flat</span>
        <span className="opacity-60">≥1%: +{breadth.pct1Up} / −{breadth.pct1Down}</span>
        {breadth.noPrevClose > 0 && <span className="text-muted-foreground/70">{breadth.noPrevClose} w/o prev close</span>}
      </div>
    </PunchCard>
  );
}

function Strip({ title, icon, rows, onPick, toneChoice }: {
  title: string; icon: React.ReactNode; rows: MoverRow[]; onPick: (r: MoverRow) => void; toneChoice: 'up' | 'down';
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon}
        <span className={cn('text-[11px] font-extrabold uppercase tracking-wider', toneChoice === 'up' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>{title}</span>
      </div>
      <div className="flex snap-x gap-2 overflow-x-auto pb-1.5">
        {(rows ?? []).slice(0, 14).map((m) => (
          <button key={`${m.strip}-${m.token}`} type="button" onClick={() => onPick(m)}
            className="group flex shrink-0 snap-start items-center gap-2 rounded-xl border border-border/70 bg-card px-2.5 py-1.5 shadow-sm transition hover:border-foreground/25 hover:shadow-md active:scale-95">
            <span className="text-xs font-extrabold">{m.symbol || DASH}</span>
            {m.stripPct != null
              ? <ChgChip pct={m.stripPct} className={toneChoice === 'up' ? 'scale-100' : 'scale-100'} />
              : <RupeeChip v={m.stripChg} />}
          </button>
        ))}
        {!rows?.length && <span className="rounded-xl border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground">{DASH} none measured yet</span>}
      </div>
    </div>
  );
}

/** Pinned (or focused) big live-detail card with momentum chips + range bar. */
function DetailCard({ row, pinned, onUnpin, index, onClear, id }: {
  row: ScanRow; pinned: boolean; onUnpin?: () => void; index: number; onClear?: () => void; id?: string;
}) {
  const winPct = (r: ScanRow, w: '1m' | '5m' | '10m') => ({ pct: pctOf(r, w), chg: chgOf(r, w) });
  const lo = row.low, hi = row.high;
  const span = lo != null && hi != null && hi > lo ? hi - lo : null;
  const marker: number | null = (() => {
    if (lo == null || hi == null || row.ltp == null || span == null) return null;
    return Math.min(100, Math.max(0, ((row.ltp - lo) / span) * 100));
  })();
  return (
    <PunchCard id={id} sign={tone(row.dayChangePct)} index={index} className="min-w-[300px] max-w-[380px] shrink-0 snap-start p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-black tracking-tight">{row.symbol}</span>
            {pinned && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" />}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{row.name || DASH}</div>
        </div>
        <div className="flex items-center gap-1">
          <span className={cn('h-2 w-2 rounded-full', row.status === 'live' ? 'bg-emerald-500 ds-breathe' : row.status === 'stale' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600')} title={row.status} />
          {onUnpin && (
            <button type="button" onClick={onUnpin} className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-destructive" aria-label="Unpin">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {onClear && (
            <button type="button" onClick={onClear} className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-destructive" aria-label="Clear focus">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-black tabular-nums leading-none">{row.ltp == null ? <span className="text-muted-foreground">{DASH}</span> : fmtPrice(row.ltp)}</span>
        <ChgChip pct={row.dayChangePct} />
        <RupeeChip v={row.dayChange} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {WINDOW_LABELS.map((w) => {
          const v = winPct(row, w);
          const t = tone(v.pct);
          return (
            <div key={w} className={cn(
              'rounded-xl p-2 text-center',
              t === 'up' ? 'bg-emerald-500/10 ring-1 ring-emerald-500/25' : t === 'down' ? 'bg-rose-500/10 ring-1 ring-rose-500/25' : 'bg-muted/60 ring-1 ring-border/50',
            )}>
              <div className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">{w}</div>
              <div className="mt-0.5 text-[13px] font-bold tabular-nums">{v.pct == null ? DASH : `${v.pct > 0 ? '+' : ''}${v.pct.toFixed(2)}%`}</div>
              <div className="text-[10px] font-semibold tabular-nums text-muted-foreground">{v.chg == null ? DASH : `${v.chg > 0 ? '+' : ''}₹${Math.abs(v.chg).toFixed(2)}`}</div>
            </div>
          );
        })}
      </div>

      {lo != null && hi != null && (
        <div className="mt-3">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-muted ring-1 ring-border/60">
            {marker != null && <span className="absolute top-1/2 z-10 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground shadow" style={{ left: `${marker}%` }} />}
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-semibold tabular-nums text-muted-foreground">
            <span>L {fmtPrice(lo)}</span><span>H {fmtPrice(hi)}</span>
          </div>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
        <span>Vol {row.volume == null ? DASH : fmtCompact(row.volume)}</span>
        <span>Bid {row.bid == null ? DASH : fmtPrice(row.bid)}</span>
        <span>Ask {row.ask == null ? DASH : fmtPrice(row.ask)}</span>
        <span>Age {row.tickAgeSec == null ? DASH : `${Math.round(row.tickAgeSec)}s`}</span>
      </div>
    </PunchCard>
  );
}

function StockCard({ row, index, pinned, onTogglePin, expanded, onToggleExpand, ticks }: {
  row: ScanRow; index: number; pinned: boolean; onTogglePin: () => void;
  expanded: boolean; onToggleExpand: () => void;
  ticks: Map<string, { ltp?: number | null; netChange?: number | null; netChangePct?: number | null; volume?: number | null }>;
}) {
  const key = `nse_cm|${row.token}`;
  const live = ticks.get(key) ?? ticks.get(`NSE|${row.token}`);
  const merged = useMemo(() => overlayRow(row, live), [row, live]);
  const dayT = tone(merged.dayChangePct);
  const tickOf = (w: WindowSel) => ({ pct: pctOf(merged, w), chg: chgOf(merged, w) });
  return (
    <PunchCard id={`watch-card-${row.token}`} sign={dayT} index={index} className="p-3.5">
      <div className="flex items-start justify-between gap-1.5">
        <button type="button" onClick={onToggleExpand} className="min-w-0 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-black tracking-tight">{row.symbol}</span>
            {Math.abs(pctOf(merged, 'day') ?? 0) >= 1 && <span className="rounded bg-foreground px-1 py-px text-[8px] font-black uppercase text-background">1%+</span>}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{row.name || DASH}</div>
        </button>
        <button type="button" onClick={onTogglePin}
          className={cn('rounded-full p-1.5 transition active:scale-90', pinned ? 'text-amber-500' : 'text-muted-foreground/60 hover:bg-muted hover:text-foreground')}
          aria-label={pinned ? 'Unpin' : 'Pin'}>
          {pinned ? <Star className="h-4 w-4 fill-amber-400 text-amber-500" /> : <Star className="h-4 w-4" />}
        </button>
      </div>

      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className={cn('text-xl font-black tabular-nums leading-none', merged.status === 'live' && 'ds-breathe')}>
          {merged.ltp == null ? <span className="text-muted-foreground">{DASH}</span> : fmtPrice(merged.ltp)}
        </span>
        <ChgChip pct={merged.dayChangePct} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1">
        {WINDOW_LABELS.map((w) => {
          const v = tickOf(w);
          return (
            <div key={w} className={cn(
              'rounded-lg px-1.5 py-1 text-center ring-1',
              v.pct == null ? 'bg-muted/50 ring-border/40' : v.pct > 0 ? 'bg-emerald-500/10 ring-emerald-500/25' : v.pct < 0 ? 'bg-rose-500/10 ring-rose-500/25' : 'bg-muted/50 ring-border/40',
            )}>
              <div className="text-[9px] font-black uppercase text-muted-foreground">{w}</div>
              <div className="text-[11px] font-bold tabular-nums leading-tight">{v.pct == null ? DASH : `${v.pct > 0 ? '+' : ''}${v.pct.toFixed(2)}%`}</div>
              <div className="text-[9px] font-semibold tabular-nums text-muted-foreground leading-tight">
                {v.chg == null ? DASH : `${v.chg > 0 ? '+' : '−'}₹${Math.abs(v.chg).toFixed(2)}`}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] font-semibold tabular-nums text-muted-foreground">
        <span>Vol {merged.volume == null ? DASH : fmtCompact(merged.volume)}</span>
        <span className={cn('flex items-center gap-1', merged.status === 'live' && 'text-emerald-600 dark:text-emerald-400')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', merged.status === 'live' ? 'bg-emerald-500' : merged.status === 'stale' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600')} />
          {merged.tickAgeSec == null ? row.status : merged.status === 'live' ? 'live' : `${Math.round(merged.tickAgeSec)}s`}
        </span>
      </div>

      {expanded && (
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-dashed border-border/70 pt-2 text-[10px] font-semibold tabular-nums text-muted-foreground">
          <span>Prev close<br /><b className="text-foreground">{merged.prevClose == null ? DASH : fmtPrice(merged.prevClose)}</b></span>
          <span>Open<br /><b className="text-foreground">{merged.open == null ? DASH : fmtPrice(merged.open)}</b></span>
          <span>High<br /><b className="text-foreground">{merged.high == null ? DASH : fmtPrice(merged.high)}</b></span>
          <span>Low<br /><b className="text-foreground">{merged.low == null ? DASH : fmtPrice(merged.low)}</b></span>
          <span>Bid<br /><b className="text-foreground">{merged.bid == null ? DASH : fmtPrice(merged.bid)}</b></span>
          <span>Ask<br /><b className="text-foreground">{merged.ask == null ? DASH : fmtPrice(merged.ask)}</b></span>
        </div>
      )}
    </PunchCard>
  );
}

/* ========================================================================== */
/* Page                                                                        */
/* ========================================================================== */

export default function WatchLivePage() {
  const [paused, setPaused] = useState(false);
  const { doc, loading, error, transport, refresh } = useScanDocument(paused);
  const { pins, toggle: togglePin } = usePins();

  // Filters
  const [winSel, setWinSel] = useState<WindowSel>('day');
  const [metric, setMetric] = useState<'pct' | 'price'>('pct');
  const [side, setSide] = useState<'all' | 'up' | 'down'>('all');
  const [thrOn, setThrOn] = useState(false);
  const [thr, setThr] = useState(1.0);
  const [q, setQ] = useState('');
  const [sortOverride, setSortOverride] = useState<'metric' | 'volume' | 'symbol'>('metric');
  const [showCount, setShowCount] = useState(RENDER_PAGE);
  const [focusToken, setFocusToken] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo<ScanRow[]>(() => doc?.rows ?? [], [doc]);
  const rowByToken = useMemo(() => new Map(rows.map((r) => [r.token, r])), [rows]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const out = rows.filter((r) => {
      const pct = pctOf(r, winSel);
      if (side === 'up' && !(pct != null && pct > 0)) return false;
      if (side === 'down' && !(pct != null && pct < 0)) return false;
      if (thrOn && !(pct != null && Math.abs(pct) >= thr)) return false;
      if (query && !( (r.symbol || '').toLowerCase().includes(query) || (r.name || '').toLowerCase().includes(query))) return false;
      return true;
    });
    if (sortOverride === 'symbol') {
      out.sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
    } else if (sortOverride === 'volume') {
      out.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
    } else {
      const dir = side === 'down' ? 1 : -1; // down side: most negative first
      const keyOf = (r: ScanRow): number => {
        const v = metric === 'pct'
          ? (winSel === 'day' ? r.dayChangePct : (r[pctKey(winSel)] as number | null))
          : (winSel === 'day' ? r.dayChange : (r[chgKey(winSel)] as number | null));
        return v == null ? (dir > 0 ? Infinity : -Infinity) : v; // unmeasured sink to the end
      };
      out.sort((a, b) => (keyOf(a) - keyOf(b)) * dir);
    }
    return out;
  }, [rows, winSel, metric, side, thrOn, thr, q, sortOverride]);

  const shown = filtered.slice(0, showCount);
  const ticks = useTokenOverlay(shown.map((r) => r.token));

  // pinned/focused rows keep their overlay even when filtered out
  const pinnedRows = useMemo(() => {
    const list: ScanRow[] = [];
    for (const token of pins.keys()) {
      const r = rowByToken.get(token);
      if (r) list.push(r);
      else list.push({ token, symbol: pins.get(token)!.symbol || token, name: pins.get(token)!.name || '', segment: 'nse_cm', ltp: null, prevClose: null, dayChange: null, dayChangePct: null, open: null, high: null, low: null, volume: null, bid: null, ask: null, tickAgeSec: null, status: 'no_data', pct1m: null, chg1m: null, pct5m: null, chg5m: null, pct10m: null, chg10m: null });
    }
    return list;
  }, [pins, rowByToken]);

  const focusRow = focusToken ? rowByToken.get(focusToken) : null;
  const mk = moversKey(winSel);
  const strips: { up: MoverRow[]; down: MoverRow[] } = {
    up: doc?.movers?.[mk.up] ?? [],
    down: doc?.movers?.[mk.down] ?? [],
  };
  const bread = doc?.breadth ?? null;
  const scan = doc?.scan ?? null;
  const feedIdle = !!scan && scan.feed === 'idle' && (scan.liveTokens ?? 0) === 0 && rows.every((r) => r.status === 'no_data');

  const pickMover = (m: MoverRow) => {
    setFocusToken(m.token);
    if (!pins.has(m.token)) void togglePin(m.token, m.symbol);
    requestAnimationFrame(() => {
      document.getElementById(`watch-card-${m.token}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const resetFilters = () => { setWinSel('day'); setMetric('pct'); setSide('all'); setThrOn(false); setQ(''); setSortOverride('metric'); setShowCount(RENDER_PAGE); };

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-3 pb-24 pt-4 sm:px-5 bottom-nav-offset">
      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-30 -mx-3 border-b border-border/60 bg-background/95 px-3 py-3 sm:-mx-5 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-600/25">
              <Activity className="h-4.5 w-4.5" />
            </span>
            <div>
              <h1 className="text-lg font-black leading-tight tracking-tight">Live Watch</h1>
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
                <TransportPill transport={transport} />
                <span>scan {scan?.cycleMs == null ? DASH : `${Math.round(scan.cycleMs)}ms`}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {scan?.universeSize != null && (
              <span className="hidden rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-[10px] font-bold text-muted-foreground sm:inline-flex">
                <Layers className="mr-1 h-3 w-3" />{fmtCompact(scan.universeSize)} NSE EQ
              </span>
            )}
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" aria-label={paused ? 'Resume' : 'Pause'}
              onClick={() => setPaused((p) => !p)}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full" aria-label="Refresh scan" onClick={() => { if (!paused) void refresh(); else { setPaused(false); void refresh(); } }}>
              <RefreshCw className={cn('h-4 w-4', loading && !paused && 'animate-spin')} />
            </Button>
            <InstallAppButton />
          </div>
        </div>
      </header>

      {loading && !doc && <LoadingState text="Scanning the whole NSE universe…" />}
      {!loading && !doc && error && (
        <EmptyState icon={WifiOff} title="Scan unavailable"
          description={`The backend scan document could not be read (${error}). It returns with the next scan cycle.`}
          action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw className="h-3.5 w-3.5" /> Retry</Button>} />
      )}

      {doc && (
        <>
          {/* -------------------------------------------------- index strip */}
          <section aria-label="Indexes" className="flex snap-x gap-2.5 overflow-x-auto pb-1">
            {(doc.indexes ?? []).map((ix, i) => <IndexCard key={`${ix.name}-${ix.token}`} ix={ix} index={i} />)}
            {!doc.indexes?.length && (
              <PunchCard sign="none" className="p-4"><span className="text-xs text-muted-foreground">Index states {DASH} — no broker index feeds yet</span></PunchCard>
            )}
          </section>

          {/* --------------------------------------------------- breadth */}
          <BreadthBar breadth={bread} />

          {/* ------------------------------- mover strips (window-aware) */}
          <section className="flex flex-col gap-3 sm:flex-row">
            <Strip title={winSel === 'day' ? 'Top gainers (day %)' : `Top gainers (${winSel})`}
              icon={<TrendingUp className={cn('h-3.5 w-3.5', 'text-emerald-600 dark:text-emerald-400')} />}
              rows={strips.up} onPick={pickMover} toneChoice="up" />
            <Strip title={winSel === 'day' ? 'Top losers (day %)' : `Top losers (${winSel})`}
              icon={<TrendingDown className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />}
              rows={strips.down} onPick={pickMover} toneChoice="down" />
          </section>

          {/* ------------------------------------------- pinned / focus */}
          {(pinnedRows.length > 0 || focusRow) && (
            <section aria-label="Pinned live detail cards" className="flex snap-x gap-2.5 overflow-x-auto pb-1">
              {focusRow && (
                <DetailCard key={`focus-${focusRow.token}`} row={focusRow} pinned={pins.has(focusRow.token)} index={0}
                  onUnpin={() => togglePin(focusRow.token, focusRow.symbol)} onClear={() => setFocusToken(null)} />
              )}
              {pinnedRows.map((r, i) => (
                <DetailCard key={`pin-${r.token}`} row={r} pinned index={(focusRow ? 1 : 0) + i}
                  onUnpin={() => togglePin(r.token, r.symbol)} />
              ))}
            </section>
          )}

          {/* --------------------------------------------- filter bar */}
          <PunchCard sign="none" className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* window */}
              <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Window">
                {(['day', '1m', '5m', '10m'] as WindowSel[]).map((w) => (
                  <button key={w} type="button" onClick={() => { setWinSel(w); setShowCount(RENDER_PAGE); }}
                    className={cn('rounded-full px-3 py-1 text-[11px] font-extrabold uppercase transition',
                      winSel === w ? 'bg-foreground text-background shadow' : 'text-muted-foreground hover:text-foreground')}>
                    {w}
                  </button>
                ))}
              </div>
              {/* metric */}
              <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Metric">
                <button type="button" onClick={() => setMetric('pct')}
                  className={cn('rounded-full px-3 py-1 text-[11px] font-extrabold transition', metric === 'pct' ? 'bg-foreground text-background shadow' : 'text-muted-foreground hover:text-foreground')}>% change</button>
                <button type="button" onClick={() => setMetric('price')}
                  className={cn('rounded-full px-3 py-1 text-[11px] font-extrabold transition', metric === 'price' ? 'bg-foreground text-background shadow' : 'text-muted-foreground hover:text-foreground')}>₹ change</button>
              </div>
              {/* side */}
              <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Side">
                {([['all', 'All'], ['up', 'Gainers'], ['down', 'Losers']] as const).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setSide(v)}
                    className={cn('rounded-full px-3 py-1 text-[11px] font-extrabold transition',
                      side === v ? (v === 'up' ? 'bg-emerald-600 text-white shadow dark:bg-emerald-500' : v === 'down' ? 'bg-rose-600 text-white shadow dark:bg-rose-500' : 'bg-foreground text-background shadow') : 'text-muted-foreground hover:text-foreground')}>
                    {label}
                  </button>
                ))}
              </div>
              {/* sort */}
              <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Sort">
                {([['metric', winSel === 'day' ? 'Day sort' : `${winSel} sort`], ['volume', 'Volume'], ['symbol', 'A→Z']] as const).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setSortOverride(v)}
                    className={cn('rounded-full px-3 py-1 text-[11px] font-bold transition', sortOverride === v ? 'bg-foreground text-background shadow' : 'text-muted-foreground hover:text-foreground')}>
                    {label}
                  </button>
                ))}
              </div>
              {/* 1% movers */}
              <button type="button" onClick={() => setThrOn((v) => !v)}
                className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-extrabold uppercase transition shadow-sm ring-1',
                  thrOn ? 'bg-amber-500 text-white ring-amber-400 hover:bg-amber-400' : 'bg-card text-muted-foreground ring-border hover:text-foreground')}>
                <ArrowUpRight className="h-3 w-3" /> ≥{thr}%
              </button>
              {thrOn && (
                <div className="flex overflow-hidden rounded-full border border-border bg-muted/40 p-0.5" role="group" aria-label="Mover threshold">
                  {[0.5, 1, 2, 3].map((t) => (
                    <button key={t} type="button" onClick={() => setThr(t)}
                      className={cn('rounded-full px-2.5 py-1 text-[11px] font-extrabold tabular-nums transition',
                        thr === t ? 'bg-amber-500 text-white shadow' : 'text-muted-foreground hover:text-foreground')}>
                      {t}%
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol or company…"
                  className="h-8 rounded-full pl-8 text-xs" aria-label="Search watch rows" />
              </div>
              {q && <Button size="sm" variant="ghost" className="h-8 rounded-full px-2" onClick={() => setQ('')}><X className="h-3.5 w-3.5" /></Button>}
            </div>
          </PunchCard>

          {/* ------------------------------------------------- grid */}
          {feedIdle ? (
            <EmptyState
              icon={Gauge}
              title="Feed is idle right now"
              description={`No live ticks have reached the engine yet (market closed or a fresh backend boot). The scanner keeps the last persisted scan and re-adapts: fast (10s) while the market trades, slow (60s) overnight. Once real WS ticks land, every card fills in — ${DASH} stays ${DASH} until then, never a fake zero.`}
              action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw className="h-3.5 w-3.5" /> Force rescan</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState icon={Layers} title="Row pages haven't landed yet"
              description="The scan summary (indexes, breadth and movers above) is real, but the per-stock row grid needs one scan pass that carries rows — the next poll fills it."
              action={<Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw className="h-3.5 w-3.5" /> Fetch rows now</Button>} />
          ) : shown.length === 0 ? (
            <EmptyState icon={Search} title="Nothing matches these filters"
              description="Loosen a filter — a gainer/loser side or the ≥% toggle can hide most of the universe, and window moves need a few minutes of real tick history."
              action={<Button size="sm" variant="outline" onClick={resetFilters}>Reset filters</Button>} />
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {shown.map((r, i) => (
                <StockCard key={r.token} row={r} index={i} pinned={pins.has(r.token)}
                  onTogglePin={() => togglePin(r.token, r.symbol)}
                  expanded={expanded === r.token}
                  onToggleExpand={() => setExpanded((cur) => (cur === r.token ? null : r.token))}
                  ticks={ticks} />
              ))}
            </div>
          )}

          {filtered.length > shown.length && shown.length > 0 && (
            <div className="flex justify-center">
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setShowCount((c) => c + RENDER_PAGE)}>
                <ListPlus className="h-3.5 w-3.5" /> Show {Math.min(RENDER_PAGE, filtered.length - shown.length)} more
                <span className="ml-1 text-muted-foreground">({filtered.length - shown.length} left)</span>
              </Button>
            </div>
          )}

          {/* ------------------------------------------ scan provenance */}
          {scan && (
            <details className="group rounded-2xl border border-border/70 bg-card p-3 text-xs">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-bold text-muted-foreground transition hover:text-foreground">
                <span className="flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" /> Scan provenance — where every number comes from</span>
                <span className="text-[10px] font-semibold">{scan.feed ?? DASH}{scan.newestTickAgeSec != null ? ` · newest tick ${Math.round(scan.newestTickAgeSec)}s` : ''}</span>
              </summary>
              <div className="mt-2 grid gap-x-6 gap-y-1.5 text-[11px] text-muted-foreground sm:grid-cols-2">
                <p><b className="text-foreground">Universe:</b> {scan.universeSize ?? DASH} NSE EQ scrips from the validated instrument master (full scan, no third-party fetch).</p>
                <p><b className="text-foreground">Quotes:</b> the backend&apos;s own WS tick store — {scan.source ?? DASH}</p>
                <p><b className="text-foreground">1m/5m/10m:</b> true window-boundary maths over the recorded price history (a value needs real ticks at both ends of the window, else {DASH}).</p>
                <p><b className="text-foreground">History depth:</b> {scan.historyDepthSeconds == null ? DASH : `${Math.round(scan.historyDepthSeconds)}s`} available right now.</p>
                <p><b className="text-foreground">Cadence:</b> every {scan.cadenceSeconds ?? DASH}s (fast in market hours, slow overnight) — last pass {scan.cycleMs ?? DASH} · {scan.generatedAt ?? doc.generatedAt}.</p>
                <p><b className="text-foreground">Live on socket:</b> the `watch_scan` channel pushes indexes / breadth / movers the moment they change; the full row grid rides REST and per-stock ticks ride the instrument channel.</p>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
