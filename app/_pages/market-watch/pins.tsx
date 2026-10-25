'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pin, PinOff, Plus, Trash2, RefreshCw, X, TrendingUp, TrendingDown, Clock3, ArrowUpRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SectionCard, LoadingState, EmptyState, ErrorState,
  fmtPrice, fmtCompact, changeTone, sign,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import {
  PinsInfo, Pinned, RankResponse, MWRow, fetchJson, useMarketWatchRealtime,
  RECONCILE_INTERVAL_MS, overlayTick, tickOf,
} from './mw-shared';
import { StockStatus } from './mw-table';

type PinTone = 'gainer' | 'loser' | 'manual';

const TONE_META: Record<PinTone, { border: string; icon: string; label: string; Icon: typeof TrendingUp }> = {
  gainer: {
    border: 'border-emerald-500/30 bg-emerald-500/5',
    icon: 'text-emerald-600 dark:text-emerald-400',
    label: 'Gainer pin',
    Icon: TrendingUp,
  },
  loser: {
    border: 'border-red-500/30 bg-red-500/5',
    icon: 'text-red-600 dark:text-red-400',
    label: 'Loser pin',
    Icon: TrendingDown,
  },
  manual: {
    border: 'border-border bg-card',
    icon: 'text-primary',
    label: 'Manual pin',
    Icon: Pin,
  },
};

function clockFromEpoch(epoch?: unknown): string {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || epoch <= 0) return '—';
  return new Date(epoch * 1000).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

function clockFromIso(value?: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-1.5 py-1">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('truncate font-mono text-[11px]', className)}>{value}</div>
    </div>
  );
}

function PinCard({
  pin,
  row,
  tone,
  onOpen,
  onRemove,
}: {
  pin: Pinned;
  row?: MWRow;
  tone: PinTone;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const meta = TONE_META[tone];
  const Icon = meta.Icon;
  const ltp = row?.ltp ?? null;
  const pct = row?.changePercent ?? null;
  const lastRank = typeof pin.lastRank === 'number' ? pin.lastRank : null;
  const appearances = typeof pin.appearances === 'number' ? pin.appearances : null;
  const lastSeen = clockFromEpoch(pin.lastSeen);
  const pinnedAt = clockFromIso((pin as any).pinnedAt ?? (pin as any).createdAt);

  return (
    <div className={cn('rounded-xl border p-3 transition-colors hover:border-primary/40', meta.border)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.icon)} />
            <span className="truncate font-semibold">{pin.symbol}</span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground" title={row?.name ?? pin.name ?? ''}>
            {row?.name ?? pin.name ?? '—'}
          </p>
        </div>
        <StockStatus status={row?.status ?? 'PENDING'} />
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <div>
          <div className="font-mono text-xl font-semibold tabular-nums">
            {ltp != null ? `₹${fmtPrice(ltp)}` : '--'}
          </div>
          <div className={cn('text-xs font-medium tabular-nums', changeTone(pct))}>
            {pct != null ? `${sign(pct)}${pct.toFixed(2)}%` : '--'}
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 text-[9px] uppercase">{meta.label}</Badge>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1">
        <Stat label="Vol" value={row?.volume != null ? fmtCompact(row.volume) : '--'} />
        <Stat
          label="5m"
          value={row?.change_5m_pct != null ? `${sign(row.change_5m_pct)}${row.change_5m_pct.toFixed(2)}%` : '--'}
          className={row?.change_5m_pct != null ? changeTone(row.change_5m_pct) : undefined}
        />
        <Stat
          label={tone === 'manual' ? 'Pinned' : 'Rank'}
          value={tone === 'manual' ? pinnedAt : lastRank != null ? `#${lastRank}` : '--'}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
          <Clock3 className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {tone === 'manual'
              ? `Pinned today ${pinnedAt === '—' ? '' : `at ${pinnedAt}`}`.trim()
              : `${appearances != null ? `Seen ${appearances}×` : 'Snapshot pin'}${lastSeen !== '—' ? ` · last ${lastSeen}` : ''}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onOpen}>
            <ArrowUpRight className="h-3 w-3" /> Open
          </Button>
          {onRemove ? (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={`Unpin ${pin.symbol}`}
              onClick={onRemove}
            >
              <PinOff className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function PinsTab({ onOpenSymbol }: { onOpenSymbol: (row: MWRow) => void }) {
  const [pins, setPins] = useState<PinsInfo | null>(null);
  const [rankByToken, setRankByToken] = useState<Record<string, MWRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbolInput, setSymbolInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const tokenSet = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of [...(pins?.gainers ?? []), ...(pins?.losers ?? []), ...(pins?.manual ?? [])]) {
      if (p?.token && !seen.has(p.token)) { seen.add(p.token); out.push(p.token); }
    }
    return out;
  }, [pins]);
  const { ticks, connectionState, connected: socketConnected, frames } = useMarketWatchRealtime(tokenSet);

  const fetchPins = useCallback(async () => {
    const res = await fetchJson<PinsInfo>('/api/market-watch/pins');
    setPins(res);
  }, []);

  /**
   * The pin document only carries token/symbol/rank metadata. The ranked
   * universe carries the backend-owned name, LTP, volume, circuit and momentum
   * fields, so one `limit=1000` read gives every pin card its full detail
   * without an N+1 `/symbol/{token}` request per pin.
   */
  const fetchRank = useCallback(async () => {
    const res = await fetchJson<RankResponse>('/api/market-watch/rank?offset=0&limit=1000&sortBy=changePercent&sortDir=desc');
    const map: Record<string, MWRow> = {};
    for (const row of res.items ?? []) map[row.token] = row;
    setRankByToken(map);
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    const [pinsResult, rankResult] = await Promise.allSettled([fetchPins(), fetchRank()]);
    if (pinsResult.status === 'rejected') {
      setError((pinsResult.reason as any)?.message ?? 'Failed to load pins');
    } else if (rankResult.status === 'rejected') {
      // Cards still render from pin metadata + realtime ticks; surface the
      // missing detail read without hiding the pin list.
      setError(`Pin details unavailable: ${(rankResult.reason as any)?.message ?? 'rank unavailable'}`);
    } else {
      setLastRefresh(new Date());
    }
    setLoading(false);
  }, [fetchPins, fetchRank]);

  useEffect(() => {
    void refreshAll();
    // doc §25/§26 — `market_watch.pins` frames already carry the pin set, and
    // the frame handler below applies them. This interval is ONLY the
    // reconciliation safety net while the socket cannot deliver.
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (socketConnected) return;
      void refreshAll();
    }, RECONCILE_INTERVAL_MS);
    return () => { if (iv) clearInterval(iv); };
  }, [refreshAll, socketConnected]);

  // doc §25/§26 — the pins frame is the live path for this tab. Manual pins
  // are NOT carried on this frame, so an established REST payload is never
  // overwritten with an empty manual list.
  useEffect(() => {
    const data = (frames['market_watch.pins'] as any)?.data;
    const list = data?.pins;
    if (!list || !Array.isArray(list.gainers)) return;
    setPins((prev) => ({
      ok: true,
      tradingDate: data.tradingDate ?? prev?.tradingDate ?? '',
      gainers: list.gainers,
      losers: list.losers ?? [],
      manual: prev?.manual ?? [],
      manualCount: prev?.manualCount ?? 0,
      maxManualPins: prev?.maxManualPins,
    }));
  }, [frames]);

  const addPin = useCallback(async () => {
    const symbol = symbolInput.trim();
    if (!symbol) return;
    setAdding(true);
    setNotice(null);
    try {
      const res = await fetchJson<{ ok: boolean; reason?: string; alreadyPinned?: boolean }>('/api/market-watch/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      if (res.ok) {
        setSymbolInput('');
        setNotice(res.alreadyPinned ? `Already pinned: ${symbol.toUpperCase()}` : `Pinned ${symbol.toUpperCase()} for today`);
        await refreshAll();
      } else {
        setNotice(`Could not pin: ${res.reason ?? 'unknown'}`);
      }
    } catch {
      setNotice('Could not pin — backend unavailable');
    } finally {
      setAdding(false);
    }
  }, [symbolInput, refreshAll]);

  const removePin = useCallback(async (tokenOrSymbol: string) => {
    try {
      await fetchJson(`/api/market-watch/pins/${encodeURIComponent(tokenOrSymbol)}`, { method: 'DELETE' });
      setNotice(null);
      await refreshAll();
    } catch {
      setNotice('Could not unpin — backend unavailable');
    }
  }, [refreshAll]);

  const clearAll = useCallback(async () => {
    setClearing(true);
    try {
      await fetchJson('/api/market-watch/pins', { method: 'DELETE' });
      await refreshAll();
    } catch {
      setNotice('Could not clear pins — backend unavailable');
    } finally {
      setClearing(false);
    }
  }, [refreshAll]);

  /** Pin metadata + ranked row + the newest realtime tick, merged read-only. */
  const detailFor = useCallback((pin: Pinned): MWRow | undefined => {
    const base = rankByToken[pin.token] ?? ({ token: pin.token, symbol: pin.symbol, name: pin.name } as MWRow);
    const tick = tickOf(ticks, pin.token);
    return tick ? overlayTick(base, tick) : base;
  }, [rankByToken, ticks]);

  const openPin = useCallback((pin: Pinned) => {
    onOpenSymbol({ ...(detailFor(pin) ?? {}), token: pin.token, symbol: pin.symbol } as MWRow);
  }, [detailFor, onOpenSymbol]);

  const autoCount = (pins?.gainers?.length ?? 0) + (pins?.losers?.length ?? 0);
  const manualPins = pins?.manual ?? [];
  const manualCount = pins?.manualCount ?? manualPins.length;
  const maxManual = pins?.maxManualPins ?? 20;

  return (
    <div className="space-y-4">
      {error && <ErrorState message={error} onRetry={refreshAll} />}
      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={connectionState === 'CONNECTED' ? 'secondary' : 'outline'}>{connectionState}</Badge>
        <Badge variant="outline" className="tabular-nums">{autoCount} auto</Badge>
        <Badge variant="outline" className="tabular-nums">{manualCount}/{maxManual} manual</Badge>
        <span>Cards show backend-owned LTP, change, volume and 5-minute move, overlaid with realtime ticks.</span>
        <div className="ml-auto flex items-center gap-2">
          {lastRefresh ? (
            <span className="text-[10px]">refreshed {lastRefresh.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={refreshAll} aria-label="Refresh pins">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {loading && !pins ? (
        <LoadingState text="Loading pins…" />
      ) : (
        <>
          {/* Automatic pins (docs §10–§14) */}
          <SectionCard
            title="Gainer Pins"
            icon={TrendingUp}
            headerRight={<Badge variant="outline" className="tabular-nums">{pins?.gainers?.length ?? 0}</Badge>}
          >
            {(pins?.gainers?.length ?? 0) === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title="No gainer pins yet"
                description="Top-5 gainer pins appear after the first ranking snapshot and are preserved while they keep appearing."
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(pins?.gainers ?? []).map((pin) => (
                  <PinCard
                    key={pin.token}
                    pin={pin}
                    row={detailFor(pin)}
                    tone="gainer"
                    onOpen={() => openPin(pin)}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Loser Pins"
            icon={TrendingDown}
            headerRight={<Badge variant="outline" className="tabular-nums">{pins?.losers?.length ?? 0}</Badge>}
          >
            {(pins?.losers?.length ?? 0) === 0 ? (
              <EmptyState
                icon={TrendingDown}
                title="No loser pins yet"
                description="Top-5 loser pins appear after the first ranking snapshot and are preserved while they keep appearing."
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(pins?.losers ?? []).map((pin) => (
                  <PinCard
                    key={pin.token}
                    pin={pin}
                    row={detailFor(pin)}
                    tone="loser"
                    onOpen={() => openPin(pin)}
                  />
                ))}
              </div>
            )}
          </SectionCard>

          {/* Manual pins (day-scoped, Mongo-backed) */}
          <SectionCard
            title="Manual Pins"
            icon={Pin}
            headerRight={
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="tabular-nums">{manualCount}/{maxManual}</Badge>
                {manualCount > 0 && (
                  <Button size="sm" variant="outline" onClick={clearAll} disabled={clearing}>
                    {clearing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Clear
                  </Button>
                )}
              </div>
            }
          >
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Symbol or token to pin (e.g. KNACK-EQ)"
                  value={symbolInput}
                  onChange={(e) => setSymbolInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addPin(); }}
                />
                <Button size="sm" onClick={addPin} disabled={adding || !symbolInput.trim()}>
                  {adding ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Pin
                </Button>
              </div>
              {manualPins.length === 0 ? (
                <EmptyState
                  icon={PinOff}
                  title="No manual pins"
                  description="Pin any locked-universe symbol to keep it on this screen — manual pins reset with the trading day."
                />
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {manualPins.map((pin) => (
                    <PinCard
                      key={pin.token}
                      pin={pin}
                      row={detailFor(pin)}
                      tone="manual"
                      onOpen={() => openPin(pin)}
                      onRemove={() => removePin(pin.token)}
                    />
                  ))}
                </div>
              )}
            </div>
          </SectionCard>

          <p className="text-[11px] text-muted-foreground">
            Manual pins are scoped to the trading day ({pins?.tradingDate ?? '—'}) and stored server-side.
            Auto pins refresh on every 30-second ranking snapshot; LTP overlays use the live tick socket.
          </p>
        </>
      )}
    </div>
  );
}
