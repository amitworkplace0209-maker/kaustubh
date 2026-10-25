'use client';

// TODAY IN DATA SAVER — chronological daily summary from THE REAL event ledger
// for the current IST market date (/api/data-saver/insights/today). Nothing is
// fabricated; a metric that is not measured renders as '—'.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, CheckCircle2, Wrench } from 'lucide-react';
import {
  InsightHeader, RefreshButton, Tile, TileGrid, SectionCard, SectionHeading,
  StatusBadge, StatusStrip, DataTable, type Column,
  countTone, val,
} from '@/components/insights/insights-ui';
import {
  getInsightsToday, useInsightsStream,
  fmtAgo, fmtCount, fmtCompact, fmtTime, severityState,
} from '@/lib/insights';
import type { TodaySummaryResponse, InsightStreamFrame } from '@/lib/insights';

interface TimelineRow {
  timestamp?: string;
  category?: string;
  severity?: string;
  event_type?: string;
  source?: string;
  message?: string;
  event_id?: string;
}

export default function TodayInDataSaverPage() {
  const [data, setData] = useState<TodaySummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await getInsightsToday());
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load today’s summary');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onStreamFrame = useCallback((frame: InsightStreamFrame) => {
    if (frame.type === 'insight_event' || frame.type === 'incident_created' || frame.type === 'incident_resolved') {
      void load(true);
    }
  }, [load]);

  const { connected } = useInsightsStream(onStreamFrame);

  const s = data?.summary;
  const incidents = data?.incidents;
  const timeline = useMemo(() => [...((data?.timeline ?? []) as TimelineRow[])].reverse(), [data]);
  const highlights = data?.highlights ?? [];
  const recoveries = data?.recoveries ?? [];

  const tlColumns: Column<TimelineRow>[] = [
    { key: 'time', label: 'Time', render: (r) => <span className="font-mono text-[9px] text-muted-foreground">{fmtTime(r.timestamp)}</span> },
    { key: 'sev', label: 'Severity', render: (r) => <StatusBadge status={severityState(r.severity)} label={r.severity || 'info'} /> },
    {
      key: 'msg', label: 'Event', render: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{r.message || r.event_type || '—'}</span>
        </span>
      ),
    },
    { key: 'cat', label: 'Category', compactHide: true, render: (r) => <span className="text-[9px] uppercase text-muted-foreground">{r.category || '—'}</span> },
    { key: 'src', label: 'Source', compactHide: true, render: (r) => <span className="text-[9px] text-muted-foreground">{r.source || '—'}</span> },
    { key: 'ago', label: 'Age', align: 'right', render: (r) => <span className="text-[9px] text-muted-foreground">{fmtAgo(r.timestamp)}</span> },
  ];

  const hiColumns: Column<(typeof highlights)[number]>[] = [
    { key: 'time', label: 'Time', render: (h) => <span className="font-mono text-[9px] text-muted-foreground">{fmtTime(h.timestamp)}</span> },
    { key: 'sev', label: 'Severity', render: (h) => <StatusBadge status={severityState(h.severity)} label={h.severity || 'info'} /> },
    { key: 'type', label: 'Event', render: (h) => <span className="truncate">{h.event_type || h.event || h.message || '—'}</span> },
    { key: 'cat', label: 'Category', compactHide: true, render: (h) => <span className="text-[9px] uppercase text-muted-foreground">{h.category || '—'}</span> },
  ];

  const recColumns: Column<(typeof recoveries)[number]>[] = [
    { key: 'name', label: 'Recovery', render: (r) => <span className="truncate">{r.name || r.event_type || '—'}</span> },
    { key: 'dur', label: 'Duration', align: 'right', render: (r) => <span>{r.duration_sec == null ? '—' : `${fmtCount(r.duration_sec)} s`}</span> },
    { key: 'mode', label: 'Mode', compactHide: true, render: (r) => <span className="text-[9px] text-muted-foreground">{r.recovery || '—'}</span> },
    { key: 'at', label: 'At', align: 'right', render: (r) => <span className="font-mono text-[9px] text-muted-foreground">{fmtTime(r.at)}</span> },
  ];

  if (error && !data) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Today in Data Saver" />
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button className="ml-3 text-xs underline" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-16">

      <InsightHeader
        title="Today in Data Saver"
        subtitle={data ? `IST market date ${data.marketDate} · generated ${fmtAgo(data.generatedAt)}` : 'Chronological daily summary from the real event ledger'}
        live={connected}
        tone="violet"
        actions={
          <>
            <Link
              href="/data-saver/insights/reports"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CalendarDays className="h-3.5 w-3.5" /> Reports
            </Link>
            <RefreshButton onClick={() => void load()} busy={loading} />
          </>
        }
        badges={
          incidents && (
            <>
              <StatusBadge status="neutral" label={`${fmtCount(incidents.total ?? null)} incidents`} />
              <StatusBadge status={Number(incidents.open) > 0 ? 'warning' : 'success'} label={`${fmtCount(incidents.open ?? null)} open`} />
              <StatusBadge status="success" label={`${fmtCount(incidents.resolved ?? null)} resolved`} />
            </>
          )
        }
      />

      {loading && !data ? (
        <div className="py-20 text-center text-xs text-muted-foreground">Compiling today’s real events…</div>
      ) : data ? (
        <>
          <TileGrid cols={5}>
            <Tile
              icon={CalendarDays} title="Events" accent="violet"
              hero={fmtCount(s?.total_events ?? null)} heroLabel="TOTAL TODAY"
              keyRows={[
                { label: 'Critical', value: fmtCount(s?.critical_events ?? null), tone: countTone(s?.critical_events ?? null, 1, 1) },
                { label: 'Warnings', value: fmtCount(s?.warnings ?? null) },
                { label: 'Errors', value: fmtCount(s?.errors ?? null), tone: countTone(s?.errors ?? null, 1, 1) },
              ]}
              detailRows={[
                { label: 'Timeline rows', value: fmtCount(timeline.length || null) },
                { label: 'Highlights', value: fmtCount(highlights.length || null) },
              ]}
              note="event ledger · market date"
            />
            <Tile
              icon={CheckCircle2} title="Ticks" accent="teal"
              hero={fmtCompact(s?.ticks ?? null)} heroLabel="RECORDED TODAY"
              keyRows={[{ label: 'Recoveries', value: fmtCount(s?.recoveries ?? null), tone: 'success' }]}
              note="tick totals from the daily summary"
            />
            <Tile
              icon={Wrench} title="Alerts" accent="amber"
              hero={fmtCount(s?.alerts ?? null)} heroLabel="ACTIVE"
              heroTone={countTone(s?.alerts ?? null)}
              keyRows={[{ label: 'Notifications', value: fmtCount(s?.notifications ?? null) }]}
              note="alerts + notifications digest"
            />
            <Tile
              icon={Wrench} title="Recoveries" accent="sky"
              hero={fmtCount(s?.recoveries ?? null)} heroLabel="CLEARED"
              heroTone="success"
              keyRows={[{ label: 'Longest', value: longestRecovery(recoveries) }]}
              note="conditions that cleared today"
            />
            <Tile
              icon={CalendarDays} title="Market Date" accent="slate"
              hero={data.marketDate || '—'} heroLabel="IST"
              keyRows={[
                { label: 'Generated', value: fmtTime(data.generatedAt) },
                { label: 'Age', value: fmtAgo(data.generatedAt) },
              ]}
              note="business date resolved backend-side"
            />
          </TileGrid>

          <SectionCard title={`Timeline · ${fmtCount(timeline.length || null)} events`} icon={CalendarDays} className="border-t-2 border-t-violet-500">
            <DataTable
              columns={tlColumns} rows={timeline} rowId={(r, i) => r.event_id || `${r.timestamp}-${i}`}
              maxHeight={380} verify="today-timeline"
              footer={<><span>showing {timeline.length}</span><span>source: insights/today.timeline</span></>}
              empty={
                <div className="py-8 text-center">
                  <CalendarDays className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
                  <p className="text-sm font-medium">No events today</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Real ledger events appear here as the day progresses</p>
                </div>
              }
            />
          </SectionCard>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SectionCard title={`Highlights · ${fmtCount(highlights.length || null)}`} icon={CheckCircle2} className="border-t-2 border-t-teal-500">
              <DataTable
                columns={hiColumns} rows={highlights} rowId={(h, i) => h.event_id || String(i)}
                maxHeight={200} verify="highlights"
                empty={<p className="py-6 text-center text-[11px] text-muted-foreground">No highlights yet.</p>}
              />
            </SectionCard>

            <SectionCard title={`Recoveries · ${fmtCount(recoveries.length || null)}`} icon={CheckCircle2} className="border-t-2 border-t-emerald-500">
              <DataTable
                columns={recColumns} rows={recoveries} rowId={(r, i) => r.event_id || r.incident_id || String(i)}
                maxHeight={200} verify="recoveries"
                empty={<p className="py-6 text-center text-[11px] text-muted-foreground">No recoveries today.</p>}
              />
            </SectionCard>
          </div>

          <StatusStrip>
            <SectionHeading>Sources</SectionHeading>
            <span className="font-mono text-[9px] text-muted-foreground">
              today · timeline · highlights · recoveries · incidents — all real ledger rows
            </span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground">val(): null → {val(null)}</span>
          </StatusStrip>
        </>
      ) : null}
    </div>
  );
}

function longestRecovery(list: TodaySummaryResponse['recoveries']): string {
  const withDur = list.filter((r) => typeof r.duration_sec === 'number') as { duration_sec: number }[];
  if (withDur.length === 0) return '—';
  return `${val(Math.max(...withDur.map((r) => r.duration_sec)))} s`;
}