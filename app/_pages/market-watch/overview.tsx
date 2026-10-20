'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Wifi, WifiOff, Gauge, Activity, AlertTriangle, Clock, TrendingUp, TrendingDown,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  StatCard, LoadingState, ErrorState, StatusBadge,
} from '@/components/design-system';
import {
  UiPayload, RankingInfo, PinsInfo, fetchJson, RECONCILE_INTERVAL_MS,
  useMarketWatchRealtime, overlayRows, STATUSES,
} from './mw-shared';
import { PinBadges } from './mw-table';

export default function OverviewTab({ onNavigate }: {
  onNavigate: (tab: string) => void;
}) {
  const [ui, setUi] = useState<UiPayload | null>(null);
  const [ranking, setRanking] = useState<RankingInfo | null>(null);
  const [pins, setPins] = useState<PinsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { ticks, connectionState, frames } = useMarketWatchRealtime([]);

  const fetchData = useCallback(async () => {
    // Doc §25: ONE failing endpoint must never blank the whole summary. Fetch
    // each panel independently and render whatever resolved; failures surface
    // as a retry banner instead of replacing the page with an error state.
    const settle = async <T,>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
      try {
        return { ok: true, value: await p };
      } catch (err: any) {
        return { ok: false, message: err?.message ?? 'request failed' };
      }
    };
    const [u, r, p] = await Promise.all([
      settle(fetchJson<UiPayload>('/api/market-watch/ui')),
      settle(fetchJson<RankingInfo>('/api/market-watch/ranking')),
      settle(fetchJson<PinsInfo>('/api/market-watch/pins')),
    ]);
    if (u.ok) setUi(u.value);
    if (r.ok) setRanking(r.value);
    if (p.ok) setPins(p.value);
    const failed = [u, r, p].filter((x): x is { ok: false; message: string } => !x.ok);
    setError(failed.length ? `Some panels unavailable: ${failed.map((f) => f.message).join(' · ')}` : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    // doc §25/§26 — the three realtime frames below already carry feedState,
    // universe size, ranking snapshot and the auto pins. This is a 60s
    // reconciliation safety net for a dropped socket, not the update path; it
    // used to be a full `/ui` + `/ranking` + `/pins` refetch every 12s.
    const iv = setInterval(fetchData, RECONCILE_INTERVAL_MS);
    return () => { if (iv) clearInterval(iv); };
  }, [fetchData]);

  // Realtime state frames overlay the REST summary (fresher than polling).
  useEffect(() => {
    const s = frames['market_watch.status'];
    const r = frames['market_watch.ranking'];
    const p = frames['market_watch.pins'];
    if (s) {
      const d = (s as any)?.data;
      if (d) {
        setUi((prev) => (prev ? {
          ...prev,
          feedState: d.feedState ?? prev.feedState,
          universeSize: d.universeSize ?? prev.universeSize,
          liveStateCount: d.liveStateCount ?? prev.liveStateCount,
          subscribedTokenCount: d.subscribedTokenCount ?? prev.subscribedTokenCount,
          statusCounts: d.statusCounts ?? prev.statusCounts,
          indexVersion: d.indexVersion ?? prev.indexVersion,
          priceCappedCount: d.priceCappedCount ?? prev.priceCappedCount,
          priceCap: d.priceCap ?? prev.priceCap,
          watchableCount: d.watchableCount ?? prev.watchableCount,
        } : prev));
      }
    }
    if (r) {
      const d = (r as any)?.data;
      if (d) {
        setRanking((prev) => (prev ? {
          ...prev,
          snapshotCount: d.snapshotCount ?? prev.snapshotCount,
          latest: d.latest ?? prev.latest,
        } : prev));
      }
    }
    if (p) {
      const d = (p as any)?.data;
      if (d?.pins && Array.isArray(d.pins.gainers)) {
        setPins((prev) => (prev ? {
          ...prev,
          tradingDate: d.tradingDate ?? prev.tradingDate,
          gainers: d.pins.gainers ?? prev.gainers,
          losers: d.pins.losers ?? prev.losers,
        } : prev));
      }
    }
  }, [frames]);

  const statusCounts = ui?.statusCounts ?? {};
  const liveGainers = overlayRows((pins?.gainers ?? []).map((p) => ({ token: p.token, symbol: p.symbol })), ticks);
  const liveLosers = overlayRows((pins?.losers ?? []).map((p) => ({ token: p.token, symbol: p.symbol })), ticks);
  const connected = ui?.feedState === 'CONNECTED' || connectionState === 'CONNECTED';
  const liveCount = ui?.liveStateCount ?? 0;
  const universeSize = ui?.universeSize ?? 0;
  const staleCount = statusCounts.STALE ?? 0;
  const noDataCount = statusCounts.NO_DATA ?? 0;
  const inactiveCount = statusCounts.INACTIVE ?? 0;
  const pendingCount = statusCounts.PENDING ?? 0;
  const priceCappedCount = ui?.priceCappedCount ?? null;
  const priceCap = ui?.priceCap ?? null;
  const watchableCount = ui?.watchableCount ?? null;

  return (
    <div className="space-y-4">
      {error && <ErrorState message={error} onRetry={fetchData} />}

      {loading ? <LoadingState text="Loading summary…" /> : (
        <>
          {/* Status legend */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Stock status</span>
            {Object.values(STATUSES).map((s) => (
              <StatusBadge key={s.label} status={s.tone} label={s.label} />
            ))}
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
              {priceCap != null && (
                <Badge variant="outline" className="text-[10px]">
                  cap ₹{priceCap}{priceCappedCount != null ? ` · ${priceCappedCount} above` : ''}
                </Badge>
              )}
              <Badge variant="outline">{connectionState}</Badge>
              {new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })} IST
            </span>
          </div>

          {/* Engine + feed summary */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={connected ? Wifi : WifiOff}
              title="Feed State"
              value={ui?.feedState ?? 'CONNECTING'}
              sub={`${liveCount} live · ${watchableCount ?? universeSize} watch${priceCappedCount ? ` · ${priceCappedCount} capped` : ''}`}
              tone={connected ? 'success' : 'warning'}
            />
            <StatCard
              icon={Gauge}
              title="Index Version"
              value={`#${ui?.indexVersion ?? 0}`}
              sub={`${ui?.generatedAt ?? ''} generated`}
              tone="neutral"
            />
            <StatCard
              icon={Activity}
              title="Live Status"
              value={`${statusCounts.LIVE ?? 0} LIVE`}
              sub={`${staleCount} stale · ${pendingCount} pending`}
              tone={staleCount > 0 ? 'warning' : (statusCounts.LIVE ?? 0) > 0 ? 'success' : 'neutral'}
            />
            <StatCard
              icon={AlertTriangle}
              title="Data Gaps"
              value={`${noDataCount} no-data`}
              sub={`${inactiveCount} inactive excluded`}
              tone={noDataCount > 0 ? 'danger' : 'neutral'}
            />
          </div>

          {/* Ranking summary */}
          {ranking?.latest ? (
            <div className="grid gap-3 md:grid-cols-3">
              <StatCard
                icon={Clock}
                title="Ranking Snapshot"
                value={ranking.latest.timestamp ?? '—'}
                sub={`#${ranking.snapshotCount ?? 0} · every 30s`}
                tone="success"
              />
              <StatCard
                icon={TrendingUp}
                title="Top Gainers"
                value={ranking.latest.topGainers.length}
                sub={<span className="truncate">{ranking.latest.topGainers.join(' · ') || '—'}</span>}
                tone="success"
              />
              <StatCard
                icon={TrendingDown}
                title="Top Losers"
                value={ranking.latest.topLosers.length}
                sub={<span className="truncate">{ranking.latest.topLosers.join(' · ') || '—'}</span>}
                tone="danger"
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No ranking snapshot yet — engine warms up after the universe builds.</p>
          )}

          {/* Auto pins preview */}
          {(pins?.gainers.length || pins?.losers.length) ? (
            <PinBadges gainers={liveGainers} losers={liveLosers} />
          ) : (
            <p className="text-xs text-muted-foreground">No pins yet — Top-5 frequency pins appear as the engine warms up.</p>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Button variant="outline" size="sm" onClick={() => onNavigate('movers')}>Movers</Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate('rank')}>Full Ranking</Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate('filters')}>Filters</Button>
            <Button variant="outline" size="sm" onClick={() => onNavigate('pins')}>Pins</Button>
          </div>
        </>
      )}
    </div>
  );
}