'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pin, PinOff, Plus, Trash2, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SectionCard, LoadingState, EmptyState, ErrorState,
} from '@/components/design-system';
import {
  PinsInfo, MWRow, fetchJson, useMarketWatchRealtime, RECONCILE_INTERVAL_MS,
} from './mw-shared';
import { PinBadges } from './mw-table';

export default function PinsTab({ onOpenSymbol }: { onOpenSymbol: (row: MWRow) => void }) {
  const [pins, setPins] = useState<PinsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [symbolInput, setSymbolInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const tokenSet = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of [...(pins?.gainers ?? []), ...(pins?.losers ?? []), ...(pins?.manual ?? [])]) {
      if (p?.token && !seen.has(p.token)) { seen.add(p.token); out.push(p.token); }
    }
    return out;
  }, [pins]);
  const { connectionState, frames } = useMarketWatchRealtime(tokenSet);

  const fetchPins = useCallback(async () => {
    try {
      setError(null);
      const res = await fetchJson<PinsInfo>('/api/market-watch/pins');
      setPins(res);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load pins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPins();
    // doc §25/§26 — `market_watch.pins` frames already carry the pin set, and
    // the frame handler below applies them. This 60s interval is only a
    // reconciliation safety net for a dropped socket; it was a 12s refetch of
    // the full pin document set on top of that.
    const iv = setInterval(fetchPins, RECONCILE_INTERVAL_MS);
    return () => { if (iv) clearInterval(iv); };
  }, [fetchPins]);

  // doc §25/§26 — the pins frame is the live path for this tab. It bootstraps
  // the card before/without REST and then keeps it current on every frame. The
  // old handler was guarded by `pins == null`, so it contributed one payload and
  // then went dead, leaving the 12s poll as the only thing keeping this fresh.
  // Manual pins are NOT carried on this frame, so an established REST payload is
  // never overwritten with an empty manual list.
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
        await fetchPins();
      } else {
        setNotice(`Could not pin: ${res.reason ?? 'unknown'}`);
      }
    } catch {
      setNotice('Could not pin — backend unavailable');
    } finally {
      setAdding(false);
    }
  }, [symbolInput, fetchPins]);

  const removePin = useCallback(async (tokenOrSymbol: string) => {
    try {
      await fetchJson(`/api/market-watch/pins/${encodeURIComponent(tokenOrSymbol)}`, { method: 'DELETE' });
      setNotice(null);
      await fetchPins();
    } catch {
      setNotice('Could not unpin — backend unavailable');
    }
  }, [fetchPins]);

  const clearAll = useCallback(async () => {
    setClearing(true);
    try {
      await fetchJson('/api/market-watch/pins', { method: 'DELETE' });
      await fetchPins();
    } catch {
      setNotice('Could not clear pins — backend unavailable');
    } finally {
      setClearing(false);
    }
  }, [fetchPins]);

  const manualRef = useMemo(() => new Map((pins?.manual ?? []).map((p) => [p.token, p])), [pins?.manual]);

  return (
    <div className="space-y-4">
      {error && <ErrorState message={error} onRetry={fetchPins} />}
      {notice && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{connectionState}</Badge>
        <span>Auto pins: Top-5 gainer/loser by snapshot frequency (preserved across ranking ticks).</span>
      </div>

      {/* Automatic pins (docs §10–§14) */}
      {pins && (
        <PinBadges
          gainers={(pins.gainers ?? []).map((p) => ({ token: p.token, symbol: p.symbol }))}
          losers={(pins.losers ?? []).map((p) => ({ token: p.token, symbol: p.symbol }))}
        />
      )}

      {/* Manual pins (day-scoped, Mongo-backed) */}
      <SectionCard
        title="Manual Pins"
        icon={Pin}
        headerRight={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="tabular-nums">
              {pins?.manualCount ?? pins?.manual?.length ?? 0}/{pins?.maxManualPins ?? 20}
            </Badge>
            {(pins?.manualCount ?? 0) > 0 && (
              <Button size="sm" variant="outline" onClick={clearAll} disabled={clearing}>
                {clearing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Clear
              </Button>
            )}
          </div>
        }
      >
        {loading ? (
          <LoadingState text="Loading pins…" />
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="Symbol or token to pin (e.g. RELIANCE)"
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addPin(); }}
              />
              <Button size="sm" onClick={addPin} disabled={adding || !symbolInput.trim()}>
                {adding ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Pin
              </Button>
            </div>
            {(pins?.manual?.length ?? 0) === 0 ? (
              <EmptyState icon={PinOff} title="No manual pins" description="Pin any symbol to keep it always visible — pins reset with the trading day." />
            ) : (
              <div className="divide-y divide-border rounded-lg border">
                {(pins?.manual ?? []).map((p) => (
                  <div
                    key={p.token}
                    className="flex items-center justify-between px-3 py-2 text-sm hover:bg-accent/40"
                    onClick={() => onOpenSymbol({ token: p.token, symbol: p.symbol, ...(p.name ? { name: p.name } : {}) })}
                  >
                    <div className="flex items-center gap-2">
                      <Pin className="h-3.5 w-3.5 text-primary" />
                      <span className="font-medium">{p.symbol}</span>
                      {p.name && <span className="text-xs text-muted-foreground truncate max-w-[200px]">{p.name}</span>}
                    </div>
                    <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Unpin ${p.symbol}`} onClick={(e) => { e.stopPropagation(); removePin(p.token); }}>
                      <PinOff className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {manualRef.size > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Manual pins are scoped to the trading day ({pins?.tradingDate ?? '—'}) and stored server-side.
        </p>
      )}
    </div>
  );
}