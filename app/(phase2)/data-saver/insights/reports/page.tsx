'use client';

// Daily / weekly Data SAVer report archive. Every figure comes from persisted
// reports (real aggregations), never from fabricated data.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, ArrowRight, CalendarDays, FileBarChart, Minus, PlusCircle, TrendingDown, TrendingUp,
} from 'lucide-react';
import {
  InsightHeader, RefreshButton, Tile, TileGrid, SectionCard,
  StatusBadge, StatusStrip, DataTable, type Column, type UiTone,
  healthTone, val, fmtAgo, fmtCount,
} from '@/components/insights/insights-ui';
import {
  getInsightsReports, getInsightsWeeklyReport, getInsightsCompare, generateInsightsReport,
} from '@/lib/insights';
import type { ReportsResponse, WeeklyReport, CompareResponse, ReportRow } from '@/lib/insights';
import { cn } from '@/lib/utils';

const COMPARE_LABELS: Record<string, string> = {
  ticks: 'Ticks', uptime: 'WS Uptime', quality: 'Quality', errors: 'Errors',
  alerts: 'Alerts', latency: 'API Latency', persistence: 'Write Success', health: 'Health',
};

function compareUnit(key: string): string {
  if (key === 'latency') return ' ms';
  if (['uptime', 'quality', 'persistence', 'health'].includes(key)) return '%';
  return '';
}

export default function InsightsReportsPage() {
  const router = useRouter();
  const [reports, setReports] = useState<ReportsResponse | null>(null);
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null);
  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [r, w, c] = await Promise.allSettled([
      getInsightsReports({ limit: 60 }),
      getInsightsWeeklyReport(1),
      getInsightsCompare(),
    ]);
    if (r.status === 'fulfilled') setReports(r.value);
    if (w.status === 'fulfilled') setWeekly(w.value);
    if (c.status === 'fulfilled') setCompare(c.value);
    if (r.status === 'rejected') setError((r.reason as Error)?.message || 'Failed to load reports');
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const report = await generateInsightsReport();
      if (report.report_date) {
        router.push(`/data-saver/insights/reports/daily/${report.report_date}`);
        return;
      }
      await load();
    } catch {
      setError('Report generation failed');
      await load();
    } finally {
      setGenerating(false);
    }
  }, [router, load]);

  const rows = useMemo<ReportRow[]>(() => reports?.reports ?? [], [reports]);
  const totals = useMemo(() => {
    const t = { ticks: 0, events: 0, errors: 0, alerts: 0, incidents: 0 };
    let countedTicks = false;
    for (const r of rows) {
      if (r.ticks != null) { t.ticks += r.ticks; countedTicks = true; }
      if (r.events != null) t.events += r.events;
      if (r.errors != null) t.errors += r.errors;
      if (r.alerts != null) t.alerts += r.alerts;
      if (r.incidents != null) t.incidents += r.incidents;
    }
    return { ...t, countedTicks };
  }, [rows]);

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
        <span className={cn('font-semibold', healthTone(r.health_score) === 'success' ? 'text-emerald-500' : healthTone(r.health_score) === 'warning' ? 'text-amber-500' : r.health_score == null ? 'text-muted-foreground' : 'text-destructive')}>
          {val(r.health_score)}
        </span>
      ),
    },
    { key: 'grade', label: 'Grade', compactHide: true, render: (r) => <span className="text-[9px] text-muted-foreground">{r.health_grade || '—'}</span> },
    { key: 'ticks', label: 'Ticks', align: 'right', render: (r) => val(r.ticks) },
    { key: 'events', label: 'Events', align: 'right', render: (r) => val(r.events) },
    { key: 'errors', label: 'Errors', align: 'right', render: (r) => <span className={r.errors ? 'text-destructive' : ''}>{val(r.errors)}</span> },
    { key: 'alerts', label: 'Alerts', align: 'right', compactHide: true, render: (r) => val(r.alerts) },
    { key: 'notif', label: 'Notifs', align: 'right', compactHide: true, render: (r) => val(r.notifications) },
    { key: 'inc', label: 'Incidents', align: 'right', compactHide: true, render: (r) => val(r.incidents) },
    { key: 'st', label: 'Status', render: (r) => <StatusBadge status={r.status === 'Generated' ? 'success' : 'warning'} label={r.status || 'Pending'} /> },
    { key: 'gen', label: 'Generated', align: 'right', compactHide: true, render: (r) => <span className="text-[9px] text-muted-foreground">{fmtAgo(r.generated_at)}</span> },
  ];

  if (error && !reports) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Reports" />
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
        title="Reports"
        subtitle="Canonical daily and weekly Data SAVer reports (real aggregations)"
        tone="orange"
        actions={
          <>
            <Link
              href="/data-saver/insights"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Link>
            <RefreshButton onClick={() => void load()} busy={loading} />
            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={generating}
              className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-orange-500 to-amber-500 px-2 py-1.5 text-[11px] font-semibold text-white transition-all hover:brightness-110 disabled:opacity-60"
            >
              {generating ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <PlusCircle className="h-3.5 w-3.5" />}
              {generating ? 'Generating…' : 'Generate Today'}
            </button>
          </>
        }
        badges={
          <>
            <StatusBadge status="neutral" label={`${fmtCount(rows.length || null)} archived`} />
            {weekly?.from_date && <StatusBadge status="info" label={`${weekly.from_date} → ${weekly.to_date}`} />}
          </>
        }
      />

      {loading && rows.length === 0 ? (
        <div className="py-20 text-center text-xs text-muted-foreground">Loading reports…</div>
      ) : (
        <>
          <TileGrid cols={5}>
            <Tile
              icon={CalendarDays} title="Weekly Health" accent={healthTone(weekly?.average_health) === 'success' ? 'teal' : 'amber'}
              hero={val(weekly?.average_health ?? null)} heroLabel="AVERAGE"
              heroTone={healthTone(weekly?.average_health)}
              keyRows={[
                { label: 'Healthy days', value: fmtCount(weekly?.healthy_days ?? null) },
                { label: 'Window', value: weekly?.to_date ?? '—' },
              ]}
              note="rollup of stored daily reports"
              footer={
                <Link href="/data-saver/insights/reports/weekly" className="flex items-center justify-between text-[9px] text-muted-foreground hover:text-foreground">
                  Open weekly <ArrowRight className="h-3 w-3" />
                </Link>
              }
            />
            <Tile
              icon={FileBarChart} title="Ticks" accent="teal"
              hero={totals.countedTicks ? fmtCount(totals.ticks) : '—'} heroLabel="ACROSS ARCHIVE"
              keyRows={[
                { label: 'Events', value: fmtCount(totals.events || null) },
                { label: 'Days', value: String(rows.length) },
              ]}
              note="sum over archived daily reports"
            />
            <Tile
              icon={TrendingUp} title="Errors" accent="danger"
              hero={fmtCount(totals.errors || null)} heroLabel="ACROSS ARCHIVE"
              heroTone={totals.errors > 0 ? 'danger' : 'success'}
              keyRows={[
                { label: 'Alerts', value: fmtCount(totals.alerts || null) },
                { label: 'Incidents', value: fmtCount(totals.incidents || null) },
              ]}
              note="sum over archived daily reports"
            />
            <Tile
              icon={FileBarChart} title="Newest Report" accent="sky"
              hero={rows[0]?.report_date || '—'} heroLabel="MOST RECENT"
              keyRows={[
                { label: 'Health', value: val(rows[0]?.health_score ?? null) },
                { label: 'Ticks', value: val(rows[0]?.ticks ?? null) },
              ]}
              detailRows={[{ label: 'Generated', value: fmtAgo(rows[0]?.generated_at) }]}
              note="latest stored daily document"
            />
            <Tile
              icon={TrendingDown} title="Baseline" accent="violet"
              hero={compare?.previousDate || '—'} heroLabel="COMPARE VS"
              keyRows={Object.entries(compare?.comparisons ?? {}).slice(0, 3).map(([k, c]) => ({
                label: COMPARE_LABELS[k] ?? k,
                value: c.today == null ? '—' : `${val(c.today)}${compareUnit(k)}`,
              }))}
              detailRows={Object.entries(compare?.comparisons ?? {}).slice(3).map(([k, c]) => ({
                label: COMPARE_LABELS[k] ?? k,
                value: c.today == null ? '—' : `${val(c.today)}${compareUnit(k)}`,
              }))}
              note={compare?.hasComparison ? 'day-over-day comparison' : 'not enough data to compare'}
            />
          </TileGrid>

          {compare?.hasComparison && (
            <SectionCard title="Day Comparison" icon={TrendingUp} className="border-t-2 border-t-violet-500"
              headerRight={<StatusBadge status="info" label={`${compare.previousDate} baseline`} />}
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(compare.comparisons ?? {}).map(([key, row]) => {
                  const up = typeof row.delta === 'number' && row.delta > 0;
                  const same = row.delta === 0;
                  // Errors / latency going UP is bad — invert the colour there.
                  const bad = ['errors', 'latency'].includes(key);
                  const good = same ? 'neutral' : (up !== bad ? 'success' : 'danger') as UiTone;
                  return (
                    <div key={key} className="rounded-lg border border-border/50 bg-card/50 px-2.5 py-2">
                      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{COMPARE_LABELS[key] ?? key}</p>
                      <p className="flex items-center gap-1 text-base font-semibold tabular-nums">
                        {row.today == null ? '—' : `${val(row.today)}${compareUnit(key)}`}
                        {same
                          ? <Minus className="h-3 w-3 text-muted-foreground" />
                          : up
                            ? <TrendingUp className={cn('h-3 w-3', good === 'success' ? 'text-emerald-500' : 'text-destructive')} />
                            : <TrendingDown className={cn('h-3 w-3', good === 'success' ? 'text-emerald-500' : 'text-destructive')} />}
                      </p>
                      <p className="text-[9px] tabular-nums text-muted-foreground">
                        {row.changePct == null ? 'Not comparable' : `${up ? '+' : ''}${row.changePct}% vs ${row.previous ?? '—'}`}
                      </p>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          <SectionCard title="Daily Reports" icon={FileBarChart} className="border-t-2 border-t-orange-500">
            <DataTable
              columns={columns} rows={rows} rowId={(r) => r.report_id || String(r.report_date)}
              maxHeight={440} verify="report-archive"
              footer={<><span>showing {rows.length} of {fmtCount(reports?.total ?? null)}</span><span>newest first</span><span>source: insights/reports</span></>}
              empty={
                <div className="py-8 text-center">
                  <FileBarChart className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm font-medium">No reports yet</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Daily reports are generated after each trading session</p>
                </div>
              }
            />
          </SectionCard>

          <StatusStrip>
            <span className="text-[10px] text-muted-foreground">
              Every archived figure is a real aggregation over persisted Data Saver state. Health score and grade come
              from the backend report document — the UI never computes or nudges them.
            </span>
          </StatusStrip>
        </>
      )}
    </div>
  );
}