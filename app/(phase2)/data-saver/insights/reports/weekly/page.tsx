'use client';

// Weekly Data SAVer report — a real 7-day rollup derived from stored daily
// reports (never recomputed or fabricated).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CalendarRange } from 'lucide-react';
import {
  InsightHeader, RefreshButton, Tile, TileGrid, SectionCard,
  StatusBadge, DataTable, type Column,
  healthTone, val, fmtCount,
} from '@/components/insights/insights-ui';
import { getInsightsWeeklyReport } from '@/lib/insights';
import type { WeeklyReport, ReportRow } from '@/lib/insights';

const TOTALS_LABELS: Record<string, string> = {
  ticks: 'Ticks', errors: 'Errors', alerts: 'Alerts', notifications: 'Notifications',
  events: 'Ledger Events', incidents: 'Incidents', downtimeEvents: 'Downtime Events',
};

export default function WeeklyReportPage() {
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setWeekly(await getInsightsWeeklyReport(1));
    } catch (err: any) {
      setError(err?.message || 'Weekly report unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const days = useMemo(() => weekly?.days ?? [], [weekly]);
  const bestDay = useMemo(
    () => days.reduce<ReportRow | null>((a, r) => (!a || (r.ticks ?? 0) > (a.ticks ?? 0) ? r : a), null),
    [days],
  );

  const columns: Column<ReportRow>[] = [
    {
      key: 'date', label: 'Date', render: (r) => (
        <Link href={`/data-saver/insights/reports/daily/${r.report_date}`} className="font-mono font-medium hover:text-orange-400">
          {r.report_date}
        </Link>
      ),
    },
    {
      key: 'health', label: 'Health', align: 'right', render: (r) => (
        <span className={healthTone(r.health_score) === 'success' ? 'text-emerald-500' : healthTone(r.health_score) === 'warning' ? 'text-amber-500' : r.health_score == null ? 'text-muted-foreground' : 'text-destructive'}>
          {val(r.health_score)}
        </span>
      ),
    },
    { key: 'grade', label: 'Grade', compactHide: true, render: (r) => <span className="text-[9px] text-muted-foreground">{r.health_grade || '—'}</span> },
    { key: 'ticks', label: 'Ticks', align: 'right', render: (r) => val(r.ticks) },
    { key: 'events', label: 'Events', align: 'right', render: (r) => val(r.events) },
    { key: 'errors', label: 'Errors', align: 'right', render: (r) => <span className={r.errors ? 'text-destructive' : ''}>{val(r.errors)}</span> },
    { key: 'alerts', label: 'Alerts', align: 'right', compactHide: true, render: (r) => val(r.alerts) },
    { key: 'st', label: 'Status', render: (r) => <StatusBadge status={r.status === 'Generated' ? 'success' : 'warning'} label={r.status || '—'} /> },
  ];

  if (error && !weekly) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Weekly Report" />
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button className="ml-3 text-xs underline" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-16">

      <InsightHeader
        title="Weekly Report"
        subtitle="Every figure is a real rollup of stored daily reports"
        tone="violet"
        actions={
          <>
            <Link
              href="/data-saver/insights/reports"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Archive
            </Link>
            <RefreshButton onClick={() => void load()} busy={loading} />
          </>
        }
        badges={
          weekly && (
            <>
              {weekly.from_date && weekly.to_date && (
                <StatusBadge status="info" label={`${weekly.from_date} → ${weekly.to_date}`} />
              )}
              <StatusBadge status={healthTone(weekly.average_health)} label={`AVG HEALTH ${val(weekly.average_health ?? null)}`} />
              <StatusBadge status="success" label={`${fmtCount(weekly.healthy_days ?? null)} healthy days`} />
            </>
          )
        }
      />

      {loading ? (
        <div className="py-20 text-center text-xs text-muted-foreground">Loading weekly report…</div>
      ) : weekly?.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {String(weekly.error)}
          <button className="ml-3 text-xs underline" onClick={load}>Retry</button>
        </div>
      ) : (
        <>
          <TileGrid cols={5}>
            <Tile
              icon={CalendarRange} title="Average Health" accent={healthTone(weekly?.average_health) === 'success' ? 'teal' : 'amber'}
              hero={val(weekly?.average_health ?? null)} heroLabel="WEEK"
              heroTone={healthTone(weekly?.average_health)}
              keyRows={[
                { label: 'Healthy days', value: fmtCount(weekly?.healthy_days ?? null), tone: 'success' },
                { label: 'Days reported', value: String(days.length) },
              ]}
              note="mean of stored daily health scores"
            />
            {Object.entries(weekly?.totals ?? {}).slice(0, 4).map(([k, v]) => (
              <Tile
                key={k} icon={CalendarRange}
                title={TOTALS_LABELS[k] ?? k}
                accent={['errors', 'downtimeEvents'].includes(k) ? 'danger' : 'slate'}
                hero={fmtCount(v ?? null)} heroLabel="WEEK TOTAL"
                heroTone={['errors', 'downtimeEvents'].includes(k) ? (Number(v) > 0 ? 'danger' : 'success') : 'neutral'}
                keyRows={[
                  { label: 'Per day avg', value: days.length ? String(Math.round(Number(v) / days.length)) : '—' },
                  { label: 'Days', value: String(days.length) },
                ]}
                note="sum over stored daily reports"
              />
            ))}
          </TileGrid>

          <SectionCard title="Daily Breakdown" icon={CalendarRange} className="border-t-2 border-t-violet-500">
            <DataTable
              columns={columns} rows={days} rowId={(r) => r.report_id || String(r.report_date)}
              maxHeight={420} verify="weekly-days"
              footer={
                <>
                  <span>showing {days.length}</span>
                  <span>best day: {bestDay?.report_date ?? '—'}</span>
                  <span>source: insights/reports/weekly</span>
                </>
              }
              empty={
                <div className="py-8 text-center">
                  <CalendarRange className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm font-medium">Not measured</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">No daily reports are available for this week</p>
                </div>
              }
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}