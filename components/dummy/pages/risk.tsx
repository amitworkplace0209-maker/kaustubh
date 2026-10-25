'use client';

import { useEffect, useMemo, useState } from 'react';
import { ShieldAlert, Percent, Wallet, Layers, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { MetricCard, ErrorState, SectionCard } from '@/components/design-system';
import { useDummyState } from '@/hooks/use-dummy-state';
import { useLatestTicks } from '@/hooks/use-latest-ticks';
import { getDummyRisk, equityLabel } from '@/lib/dummy';
import { feedDummyLtp } from '@/lib/dummy-ltp';
import { DummyThemedPage, DummyBadge } from '@/components/dummy/ui';
import { cn } from '@/lib/utils';

export default function DummyRisk() {
  const { state, error, refresh } = useDummyState(2500);
  const [riskDetail, setRiskDetail] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    let on = true;
    getDummyRisk().then((r) => { if (on) setRiskDetail(r); }).catch(() => {});
    return () => { on = false; };
  }, []);

  const symbols = useMemo(() => new Set((state?.positions || []).map((p) => p.symbol)), [state?.positions]);
  const { latest } = useLatestTicks(true);
  useEffect(() => {
    for (const sym of symbols) {
      const t = latest.get(sym);
      if (t && typeof t.ltp === 'number' && t.ltp > 0) feedDummyLtp(sym, t.ltp);
    }
  }, [latest, symbols]);

  if (error && !state) {
    return <DummyThemedPage><ErrorState message={error} onRetry={() => void refresh()} /></DummyThemedPage>;
  }

  const risk = state?.risk;
  if (!risk) return <DummyThemedPage><div className="text-sm text-muted-foreground">No risk data yet.</div></DummyThemedPage>;

  const utilized = risk.usedMargin > 0 ? (risk.marginUtilizationPct ?? (risk.usedMargin / Math.max(risk.balance, 1)) * 100) : 0;
  const utilTone = utilized > 80 ? 'text-red-500' : utilized > 60 ? 'text-amber-500' : 'text-emerald-500';
  const heavy = (riskDetail?.maxPositionExposurePct ?? 0) > 15 || (riskDetail?.concentrationPct ?? 0) > 20;

  return (
    <DummyThemedPage>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Risk Dashboard</h1>
        <DummyBadge />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard icon={Wallet} title="Balance" value={equityLabel(risk.balance)} tone="neutral" />
        <MetricCard icon={Layers} title="Used margin" value={equityLabel(risk.usedMargin)} tone="warning" />
        <MetricCard icon={ShieldAlert} title="Exposure" value={equityLabel(risk.exposure)} tone="teal" />
        <MetricCard icon={Percent} title="Utilization" value={`${utilized.toFixed(1)}%`} tone={utilized > 80 ? 'danger' : utilized > 60 ? 'warning' : 'neutral'} />
      </div>

      <SectionCard title="Margin utilization" icon={Percent}>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{equityLabel(risk.usedMargin)} of {equityLabel(risk.balance)} used</span>
            <span className={cn('font-mono font-semibold', utilTone)}>{utilized.toFixed(1)}%</span>
          </div>
          <Progress value={Math.min(utilized, 100)} className="h-3" />
          {utilized > 80 && (
            <p className="flex items-center gap-2 text-xs text-red-500">
              <AlertTriangle className="h-4 w-4" /> High utilization — consider reducing exposure or adding virtual capital.
            </p>
          )}
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Key risk numbers</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <RiskRow label="Open positions" value={String(risk.openPositions)} />
            <RiskRow label="Today's orders" value={String(risk.todayOrders)} />
            <RiskRow label="Active alerts" value={String(risk.activeAlerts)} />
            <RiskRow label="Pending targets" value={String(risk.pendingTargets)} />
            <RiskRow label="Free margin" value={equityLabel(risk.freeMargin)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Position concentration</CardTitle></CardHeader>
          <CardContent>
            {((riskDetail?.positions || []) as Array<Record<string, any>>).length === 0 ? (
              <p className="text-sm text-muted-foreground">No open positions to analyse.</p>
            ) : (
              <div className="space-y-3">
                {((riskDetail?.positions || []) as Array<Record<string, any>>).slice(0, 5).map((p) => {
                  const pct = Number(p.exposurePct ?? p.concentrationPct ?? p.marginUtilizationPct ?? 0);
                  const tone = pct > 15 ? 'text-red-500' : pct > 8 ? 'text-amber-500' : 'text-emerald-500';
                  return (
                    <div key={String(p.symbol)} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium">{p.symbol}</span>
                        <span className={cn('font-mono', tone)}>{pct.toFixed(1)}%</span>
                      </div>
                      <Progress value={Math.min(pct * 4, 100)} className="h-1.5" />
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {heavy && (
        <p className="text-xs text-amber-500">Heads-up: a single position is using significant margin. Dummy risk checks will reject new orders that breach limits.</p>
      )}

      {((riskDetail?.breaks || []) as Array<Record<string, any>>).length > 0 && (
        <SectionCard title="Risk rule breaks" icon={AlertTriangle}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((riskDetail?.breaks || []) as Array<Record<string, any>>).map((b, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{b.rule}</TableCell>
                    <TableCell><span className={b.level === 'hard' ? 'text-red-500' : 'text-amber-500'}>{String(b.level).toUpperCase()}</span></TableCell>
                    <TableCell className="text-muted-foreground">{b.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      )}
    </DummyThemedPage>
  );
}

function RiskRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold tabular-nums">{value}</span>
    </div>
  );
}