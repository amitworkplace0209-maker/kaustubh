'use client';

// ---- Data Center top summary cards (4 premium cards) ----
// Values come ONLY from the normalized DataCenterStatus (null -> N/A).

import { Boxes, Radio, HardDrive, Activity } from 'lucide-react';
import { MetricCard } from '@/components/design-system';
import { fmtBytes } from '@/lib/data-center';
import { formatRate, type DataCenterStatus, type TrendDirection } from '@/lib/data-center-status';

const TREND_META: Record<TrendDirection, { icon: string; cls: string; label: string }> = {
  rising: { icon: '\u2191', cls: 'text-success', label: 'increasing' },
  stable: { icon: '\u2192', cls: 'text-muted-foreground', label: 'stable' },
  falling: { icon: '\u2193', cls: 'text-warning', label: 'decreasing' },
};

export default function SummaryCards({ status, loading }: { status: DataCenterStatus | null; loading: boolean }) {
  const active = status?.activeStocks;
  const total = status?.totalStocks;
  const activePct =
    active != null && total != null && total > 0 ? Math.round((active / total) * 100) : null;

  const rate = status?.tickStream.tickRatePerSec ?? null;
  const trend = TREND_META[status?.tickStream.trend ?? 'stable'];

  const diskPct = status?.storage.diskPercent;
  const usedBytes = status?.storage.diskUsedBytes;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard
        icon={Boxes}
        tone="cyan"
        title="Total Stocks"
        value={total != null ? total.toLocaleString('en-IN') : null}
        sub="subscribed instruments"
        loading={loading}
      />
      <MetricCard
        icon={Radio}
        tone="success"
        title="Active Stocks"
        value={active != null ? active.toLocaleString('en-IN') : null}
        sub={activePct != null ? `${activePct}% active rate` : 'of subscribed instruments'}
        valueClass={active != null ? 'text-success' : undefined}
        loading={loading}
      />
      <MetricCard
        icon={Activity}
        tone="blue"
        title="Tick Rate"
        value={rate != null ? `${formatRate(rate)}/s` : null}
        sub={
          <>
            <span aria-hidden className={`mr-1 font-semibold ${trend.cls}`}>{trend.icon}</span>
            Rolling {Math.round(status?.tickStream.rollingWindowSec ?? 10)}s · {trend.label}
          </>
        }
        loading={loading}
      />
      <MetricCard
        icon={HardDrive}
        tone="orange"
        title="Storage"
        value={diskPct != null ? `${diskPct.toFixed(1)}%` : null}
        sub={
          <span className="flex flex-col gap-1">
            <span>{fmtBytes(usedBytes)} used</span>
            <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full transition-all ${diskPct != null && diskPct >= 90 ? 'bg-destructive' : 'bg-warning'}`}
                style={{ width: `${Math.min(Math.max(diskPct ?? 0, 0), 100)}%` }}
              />
            </span>
          </span>
        }
        loading={loading}
      />
    </div>
  );
}
