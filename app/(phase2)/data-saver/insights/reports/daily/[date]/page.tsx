'use client';

// Full canonical daily report for one market date. Data comes straight from the
// persisted report (generated on demand by the backend when missing).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CheckCircle2, CircleAlert, Wrench } from 'lucide-react';
import {
  InsightHeader, Tile, TileGrid, SectionCard, SectionHeading,
  StatusBadge, KVBlock, DataTable, type Column,
  healthTone, pickScalars, scalarsToKV, val,
  fmtCount, fmtTime, fmtDateTime, severityState,
} from '@/components/insights/insights-ui';
import { getInsightsDailyReport, generateInsightsReport } from '@/lib/insights';
import type { DailyReport, Incident } from '@/lib/insights';
import { cn } from '@/lib/utils';

type Row = Record<string, any>;

export default function DailyReportPage() {
  const params = useParams<{ date: string }>();
  const date = params.date;
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getInsightsDailyReport(date));
    } catch (err: any) {
      setError(err?.message || 'Report unavailable');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      setReport(await generateInsightsReport(date));
    } catch (err: any) {
      setError(err?.message || 'Regeneration failed');
    } finally {
      setRegenerating(false);
    }
  }, [date]);

  if (loading) {
    return (
      <div className="space-y-3">
        <InsightHeader title={`Daily Report · ${date}`} subtitle="Canonical end-of-session Data SAVer report" />
        <div className="py-20 text-center text-xs text-muted-foreground">Loading report…</div>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="space-y-3">
        <InsightHeader title={`Daily Report · ${date}`} />
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button className="ml-3 text-xs underline" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }

  const s = report?.summary;
  const h = report?.overall_health;
  const dims = h?.dimensions ? Object.entries(h.dimensions).filter(([, v]) => v != null) as [string, number][] : [];
  const groups = (report?.error_summary?.groups ?? []) as Row[];
  const incidents = (report?.incident_summary?.incidents ?? []) as Incident[];
  const highlights = (report?.highlights ?? []) as Row[];
  const recoveries = (report?.recoveries ?? []) as Row[];
  const timeline = (report?.timeline ?? []) as Row[];

  const errorCols: Column<Row>[] = [
    { key: 'st', label: 'State', render: (g) => <StatusBadge status={g.resolved ? 'success' : severityState(g.severity)} label={g.resolved ? 'resolved' : g.severity || 'error'} /> },
    {
      key: 'type', label: 'Error', render: (g) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{g.eventType || '—'}</span>
          {g.sampleMessage && <span className="block truncate text-[9px] text-muted-foreground">{g.sampleMessage}</span>}
        </span>
      ),
    },
    { key: 'cat', label: 'Category', compactHide: true, render: (g) => <span className="text-[9px] uppercase text-muted-foreground">{g.category || '—'}</span> },
    { key: 'occ', label: 'Occurrences', align: 'right', render: (g) => val(g.occurrences) },
    { key: 'last', label: 'Last', align: 'right', render: (g) => <span className="text-[9px] text-muted-foreground">{fmtTime(g.lastSeen)}</span> },
  ];

  const incCols: Column<Incident>[] = [
    { key: 'st', label: 'Status', render: (i) => <StatusBadge status={i.status === 'resolved' ? 'success' : severityState(i.severity)} label={i.status === 'resolved' ? 'resolved' : i.status || 'open'} /> },
    {
      key: 'title', label: 'Incident', render: (i) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{i.title || '—'}</span>
          {i.message && <span className="block truncate text-[9px] text-muted-foreground">{i.message}</span>}
        </span>
      ),
    },
    { key: 'kind', label: 'Kind', compactHide: true, render: (i) => <span className="text-[9px] uppercase text-muted-foreground">{i.kind || '—'}</span> },
    { key: 'det', label: 'Detected', align: 'right', compactHide: true, render: (i) => <span className="text-[9px] text-muted-foreground">{fmtDateTime(i.detected_at)}</span> },
    { key: 'dur', label: 'Duration', align: 'right', render: (i) => (typeof i.duration_sec === 'number' ? `${fmtCount(i.duration_sec)} s` : <span className="text-muted-foreground">—</span>) },
  ];

  const evCols: Column<Row>[] = [
    { key: 'time', label: 'Time', render: (r) => <span className="font-mono text-[9px] text-muted-foreground">{fmtTime(r.timestamp ?? r.at)}</span> },
    { key: 'sev', label: 'Severity', render: (r) => <StatusBadge status={severityState(r.severity)} label={r.severity || 'info'} /> },
    { key: 'msg', label: 'Event', render: (r) => <span className="block truncate">{r.message || r.name || r.event_type || r.type || '—'}</span> },
    { key: 'cat', label: 'Category', compactHide: true, render: (r) => <span className="text-[9px] uppercase text-muted-foreground">{r.category || r.type || '—'}</span> },
  ];

  return (
    <div className="space-y-3 pb-16">

      <InsightHeader
        title={`Daily Report · ${date}`}
        subtitle="Every figure is a real aggregation over persisted Data Saver state"
        tone="orange"
        actions={
          <>
            <Link
              href="/data-saver/insights/reports"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Archive
            </Link>
            <button
              type="button" onClick={() => void handleRegenerate()} disabled={regenerating}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
            >
              <span className={cn('h-3.5 w-3.5', regenerating && 'animate-spin')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg></span>
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
          </>
        }
        badges={
          report?.generated_at && (
            <span className="font-mono text-[9px] text-muted-foreground">Generated {fmtDateTime(report.generated_at)}</span>
          )
        }
      />

      {report?.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {String(report.error)}
          <button className="ml-3 text-xs underline" onClick={load}>Retry</button>
        </div>
      ) : (
        <>
          <TileGrid cols={5}>
            <Tile
              icon={CheckCircle2} title="Overall Health" accent={healthTone(h?.score ?? null) === 'success' ? 'teal' : 'amber'}
              hero={val(h?.score ?? null)} heroLabel={String(h?.grade ?? h?.status ?? 'NOT MEASURED').toUpperCase()}
              heroTone={healthTone(h?.score ?? null)}
              keyRows={dims.slice(0, 3).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: `${val(v)}%` }))}
              detailRows={dims.slice(3).map(([k, v]) => ({ label: k.replace(/_/g, ' '), value: `${val(v)}%` }))}
              note="backend health score — never recomputed here"
            />
            {([
              ['Events', 'total_events', 'violet'],
              ['Ticks', 'ticks', 'teal'],
              ['Errors', 'errors', 'danger'],
              ['Alerts', 'alerts', 'amber'],
            ] as const).map(([label, key, accent]) => (
              <Tile
                key={key} icon={CheckCircle2} title={label} accent={accent}
                hero={val((s as Row)?.[key] ?? null)} heroLabel="TODAY"
                heroTone={key === 'errors' || key === 'alerts' ? (((s as Row)?.[key] ?? 0) > 0 ? 'danger' : 'success') : 'neutral'}
                keyRows={key === 'total_events' ? [
                  { label: 'Critical', value: val((s as Row)?.critical_events ?? null), tone: ((s as Row)?.critical_events ?? 0) > 0 ? 'danger' : 'success' },
                  { label: 'Warnings', value: val((s as Row)?.warnings ?? null) },
                  { label: 'Recoveries', value: val((s as Row)?.recoveries ?? null), tone: 'success' },
                ] : key === 'ticks' ? [
                  { label: 'Market', value: val((report?.market as Row)?.market_state ?? null) },
                ] : key === 'alerts' ? [
                  { label: 'Notifications', value: val((s as Row)?.notifications ?? null) },
                ] : [
                  { label: 'Ledger total', value: val(report?.event_totals?.total ?? null) },
                ]}
                note={`day ${date}`}
              />
            ))}
          </TileGrid>

          <SectionCard title="Day Summary" icon={CheckCircle2} className="border-t-2 border-t-orange-500">
            <KVBlock items={scalarsToKV(s as Row)} cols={4} verify="day-summary" />
          </SectionCard>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <SectionCard title="Market" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.market))} cols={2} />
            </SectionCard>
            <SectionCard title="Database" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.database_summary))} cols={2} />
            </SectionCard>
            <SectionCard title="Scheduler" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.scheduler_summary))} cols={2} />
            </SectionCard>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SectionCard title="Tick Summary" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.tick_summary))} cols={2} />
              <div className="mt-3">
                <SectionHeading>Pipeline</SectionHeading>
                <KVBlock items={scalarsToKV(pickScalars(report?.pipeline_summary))} cols={2} />
              </div>
            </SectionCard>
            <SectionCard title="WebSocket" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.websocket_summary))} cols={2} />
            </SectionCard>
            <SectionCard title="Data Quality" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.quality_summary))} cols={2} />
            </SectionCard>
            <SectionCard title="API Telemetry" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.api_summary))} cols={3} />
            </SectionCard>
            <SectionCard title="Notifications" icon={CheckCircle2}>
              <KVBlock items={scalarsToKV(pickScalars(report?.notification_summary))} cols={2} />
            </SectionCard>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SectionCard title="Error Center" icon={CircleAlert}
              headerRight={report?.error_summary ? (
                <StatusBadge
                  status={Number(report.error_summary.open) > 0 ? 'danger' : 'success'}
                  label={`${fmtCount(report.error_summary.open ?? null)} open · ${fmtCount(report.error_summary.occurrences ?? null)} occurrences`}
                />
              ) : undefined}
            >
              <DataTable
                columns={errorCols} rows={groups} rowId={(g, i) => g.groupId || g.fingerprint || String(i)}
                maxHeight={240} verify="daily-error-groups"
                footer={<span>{groups.length} group(s)</span>}
                empty={<NoRows icon={CheckCircle2} title="No recurring errors" text="No error groups recorded for this day" />}
              />
            </SectionCard>

            <SectionCard title="Incidents" icon={Wrench}
              headerRight={report?.incident_summary ? (
                <StatusBadge
                  status={Number(report.incident_summary.open) > 0 ? 'warning' : 'success'}
                  label={`${fmtCount(report.incident_summary.total ?? null)} total · ${fmtCount(report.incident_summary.resolved ?? null)} resolved`}
                />
              ) : undefined}
            >
              <DataTable
                columns={incCols} rows={incidents} rowId={(i) => i.incident_id}
                maxHeight={240} verify="daily-incidents"
                footer={<span>{incidents.length} incident(s)</span>}
                empty={<NoRows icon={CheckCircle2} title="No incidents" text="No incidents were correlated for this day" />}
              />
            </SectionCard>
          </div>

          {report?.event_totals && (
            <SectionCard title="Ledger" icon={CheckCircle2} className="border-t-2 border-t-slate-500">
              <KVBlock
                items={scalarsToKV({
                  total: report.event_totals.total,
                  ...(report.event_totals.by_severity ?? {}),
                })}
                cols={4}
                verify="ledger-totals"
              />
            </SectionCard>
          )}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <SectionCard title={`Highlights · ${fmtCount(highlights.length || null)}`} icon={CheckCircle2}>
              <DataTable columns={evCols} rows={highlights} rowId={(r, i) => String(r.event_id ?? i)} maxHeight={200} verify="report-highlights"
                empty={<p className="py-4 text-center text-[11px] text-muted-foreground">No highlights.</p>} />
            </SectionCard>
            <SectionCard title={`Recoveries · ${fmtCount(recoveries.length || null)}`} icon={CheckCircle2}>
              <DataTable columns={evCols} rows={recoveries} rowId={(r, i) => String(r.event_id ?? r.incident_id ?? i)} maxHeight={200} verify="report-recoveries"
                empty={<p className="py-4 text-center text-[11px] text-muted-foreground">No recoveries.</p>} />
            </SectionCard>
          </div>

          {timeline.length > 0 && (
            <SectionCard title={`Full Timeline · ${fmtCount(timeline.length || null)}`} icon={CheckCircle2} className="border-t-2 border-t-orange-500">
              <DataTable columns={evCols} rows={timeline} rowId={(r, i) => String(r.event_id ?? i)} maxHeight={320} verify="report-timeline"
                footer={<><span>showing {timeline.length}</span><span>source: persisted daily report</span></>} />
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}

function NoRows({ icon, title, text }: { icon: React.ElementType; title: string; text: string }) {
  const Icon = icon;
  return (
    <div className="py-6 text-center">
      <Icon className="mx-auto mb-2 h-5 w-5 text-emerald-500" />
      <p className="text-xs font-medium">{title}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{text}</p>
    </div>
  );
}