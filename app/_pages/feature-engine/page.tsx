'use client';

import {
  Activity, Calculator, Gauge, Layers, RefreshCw, Sparkles, Timer,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  PageHeader,
  SectionCard,
  MetricCard,
  StatCard,
  StatusBadge,
  EmptyState,
  LoadingState,
  ErrorState,
} from '@/components/design-system';
import { useEngineStatus, useOneShot } from '@/lib/engine-realtime';

/**
 * SERVICES -> Feature Engine
 *
 * Real calculated market-data features (change %, vwap, sma windows) computed
 * from real ticks with per-calculation status and NO fabricated values.
 * Live engine status arrives over WebSocket #2 (`engines` channel) via the
 * Connection Manager; the latest-feature cache is fetched once as a fallback.
 * Missing values → — / N/A.
 */
const ENGINE = '/api/services/engines/feature_engine';

function fmtNum(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '\u2014';
  return Number(n).toLocaleString('en-IN');
}

const STATUS_TONE: Record<string, string> = {
  AVAILABLE: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  WARMING_UP: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  MISSING_INPUT: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

function calcBadge(status?: string) {
  const s = status ?? 'MISSING_INPUT';
  const badgeStatus: 'success' | 'warning' | 'danger' | 'neutral' =
    s === 'AVAILABLE' ? 'success' : s === 'WARMING_UP' ? 'warning' : 'danger';
  return <StatusBadge status={badgeStatus} label={s} />;
}

export default function FeatureEnginePage() {
  const { data, error, refresh } = useEngineStatus<any>('feature_engine', ENGINE);
  const { data: latest, refresh: refreshLatest } = useOneShot<any>(`${ENGINE}/latest`);

  const m = data?.metrics?.custom ?? {};
  const rows = (latest?.features ?? []) as any[];
  const activeTokens = Number(m.activeTokens ?? latest?.tokens?.length ?? 0);
  const missingInputs = Number(m.missingInputs ?? 0);
  const invalidInputs = Number(m.invalidInputs ?? 0);
  const totalCalculations = m.totalCalculations;
  const engineState = data?.state ?? '—';
  const isRunning = engineState === 'RUNNING';

  const inputTone: 'success' | 'warning' | 'danger' | 'neutral' =
    invalidInputs > 0 ? 'danger' : missingInputs > 0 ? 'warning' : 'success';
  const engineTone: 'success' | 'warning' | 'neutral' =
    isRunning && activeTokens > 0 ? 'success' : isRunning ? 'warning' : 'neutral';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature Engine"
        subtitle={`${data?.engineName ?? 'Feature Engine'} · v${data?.version ?? '—'} · schema v1 (marketData / features separated)`}
      >
        <StatusBadge status={isRunning ? 'success' : engineState === 'WARMING_UP' ? 'warning' : 'neutral'} label={engineState} />
        <Badge variant="outline" className="hidden sm:inline-flex font-mono text-[10px]">featureVersion v1</Badge>
        <Button size="sm" variant="outline" onClick={() => { refresh(); refreshLatest(); }}>
          <RefreshCw className="mr-1 h-3 w-3" /> Refresh
        </Button>
      </PageHeader>

      {error && <ErrorState message={`Feature Engine status: ${error}`} onRetry={() => { refresh(); refreshLatest(); }} />}
      {!data && !error && <LoadingState text="Loading Feature Engine…" />}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Activity}
              title="Active Tokens"
              value={fmtNum(activeTokens)}
              sub={`${fmtNum(totalCalculations)} calculations · ${data.health ?? '—'}`}
              tone={engineTone}
            />
            <StatCard
              icon={Sparkles}
              title="Input Quality"
              value={missingInputs > 0 || invalidInputs > 0 ? `${fmtNum(missingInputs)} missing` : 'Clean'}
              sub={invalidInputs > 0 ? `${fmtNum(invalidInputs)} invalid` : 'Volume never fabricated'}
              tone={inputTone}
            />
            <StatCard
              icon={Gauge}
              title="Latency"
              value={m.lastCalculationLatencyMs != null ? `${Number(m.lastCalculationLatencyMs).toFixed(2)} ms` : '—'}
              sub={m.avgCalculationLatencyMs != null ? `avg ${Number(m.avgCalculationLatencyMs).toFixed(2)} ms` : 'no avg yet'}
              tone={m.lastCalculationLatencyMs != null ? (Number(m.lastCalculationLatencyMs) > 100 ? 'warning' : 'success') : 'neutral'}
            />
            <StatCard
              icon={Layers}
              title="Output Schema"
              value={`${rows.length} rows`}
              sub="change · vwap · sma"
              tone={rows.length > 0 ? 'success' : 'neutral'}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SectionCard title="Engine" icon={Activity} headerRight={<StatusBadge status={isRunning ? 'success' : 'neutral'} label={engineState} />} className="shadow-soft">
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Active tokens</span><span className="font-mono">{fmtNum(activeTokens)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Total calculations</span><span className="font-mono">{fmtNum(m.totalCalculations)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Health</span><span className="font-mono">{data.health ?? '\u2014'}</span></div>
              </div>
            </SectionCard>

            <SectionCard title="Input Quality" icon={Sparkles} className="shadow-soft">
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Missing inputs</span><span className={`font-mono ${Number(m.missingInputs) > 0 ? 'text-amber-300' : ''}`}>{fmtNum(m.missingInputs)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Invalid inputs</span><span className={`font-mono ${Number(m.invalidInputs) > 0 ? 'text-rose-300' : ''}`}>{fmtNum(m.invalidInputs)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Volume fabricated</span><span className="font-mono">never</span></div>
              </div>
            </SectionCard>

            <SectionCard title="Latency" icon={Gauge} className="shadow-soft">
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">Last calc latency</span><span className="font-mono">{m.lastCalculationLatencyMs != null ? `${Number(m.lastCalculationLatencyMs).toFixed(2)} ms` : '\u2014'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Avg calc latency</span><span className="font-mono">{m.avgCalculationLatencyMs != null ? `${Number(m.avgCalculationLatencyMs).toFixed(2)} ms` : '\u2014'}</span></div>
              </div>
            </SectionCard>

            <SectionCard title="Output Schema" icon={Layers} className="shadow-soft">
              <div className="space-y-1 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">marketData</span><span className="font-mono">raw ticks</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">features</span><span className="font-mono">change · vwap · sma</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">calculationStatus</span><span className="font-mono">per feature</span></div>
              </div>
            </SectionCard>
          </div>

          <SectionCard
            title="Latest Calculated Features (real cache)"
            icon={Timer}
            headerRight={<Badge variant="outline">{rows.length} rows</Badge>}
            className="shadow-soft"
          >
            {rows.length === 0 ? (
              <EmptyState
                icon={Calculator}
                title="No features yet"
                description="No features calculated yet — the engine computes features only from real incoming ticks (featureVersion v1)."
              />
            ) : (
              <div className="max-h-96 overflow-auto rounded-lg border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1">Symbol</th>
                      <th className="px-2 py-1">Token</th>
                      <th className="px-2 py-1">Change</th>
                      <th className="px-2 py-1">Change %</th>
                      <th className="px-2 py-1">Spread</th>
                      <th className="px-2 py-1">VWAP</th>
                      <th className="px-2 py-1">SMA-10</th>
                      <th className="px-2 py-1">SMA-60</th>
                      <th className="px-2 py-1">Status</th>
                      <th className="px-2 py-1">Missing</th>
                      <th className="px-2 py-1">Quality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any) => {
                      const f = r.features ?? {};
                      const cs = r.calculationStatus ?? {};
                      return (
                        <tr key={r.instrumentToken ?? r.symbol} className="border-t">
                          <td className="px-2 py-1 font-medium">{r.symbol || '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{r.instrumentToken ?? '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{f.change != null ? Number(f.change).toFixed(2) : '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{f.changePercent != null ? `${Number(f.changePercent).toFixed(2)}%` : '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{f.spread != null ? Number(f.spread).toFixed(2) : '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{f.vwap != null ? Number(f.vwap).toFixed(2) : '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{f.sma_10 != null ? Number(f.sma_10).toFixed(2) : '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">{f.sma_60 != null ? Number(f.sma_60).toFixed(2) : '\u2014'}</td>
                          <td className="px-2 py-1">{calcBadge(cs.change ?? cs.changePercent ?? cs.vwap)}</td>
                          <td className="px-2 py-1 font-mono text-[10px]">{(r.missingInputs ?? []).join(', ') || '\u2014'}</td>
                          <td className="px-2 py-1 font-mono">
                            {r.inputQuality?.source ?? ''}{r.inputQuality?.sequence != null ? ` seq ${r.inputQuality.sequence}` : ''}{r.inputQuality?.complete != null ? ` ${r.inputQuality.complete ? 'complete' : 'partial'}` : ''}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
