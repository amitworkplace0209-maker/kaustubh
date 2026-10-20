'use client';

// Typed Data SAVer report (websocket / tick / quality / api / persistence /
// errors / system). All data is real, generated on demand by the backend.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, FileBarChart } from 'lucide-react';
import {
  InsightHeader, RefreshButton, ChipButton, Tile, TileGrid, SectionCard, SectionHeading,
  StatusBadge, KVBlock, DataTable, type Column, pickScalars, scalarsToKV,
  countTone, fmtCount, fmtTime, severityState,
} from '@/components/insights/insights-ui';
import {
  getInsightsTypeReport, istDateNow,
  INSIGHT_REPORT_TYPES,
} from '@/lib/insights';
import type { InsightReportType, TypeReport } from '@/lib/insights';

const TYPE_LABELS: Record<InsightReportType, string> = {
  websocket: 'WebSocket', tick: 'Tick Pipeline', quality: 'Data Quality',
  api: 'API Telemetry', persistence: 'Persistence', errors: 'Error Center', system: 'System',
};

const TYPE_ACCENT: Record<InsightReportType, string> = {
  websocket: 'sky', tick: 'teal', quality: 'violet', api: 'indigo' as never,
  persistence: 'amber', errors: 'danger', system: 'slate',
};

const META_KEYS = new Set(['reportType', 'reportDate', 'generatedAt', 'error']);

export default function TypeReportPage() {
  const params = useParams<{ type: string }>();
  const type = params.type as InsightReportType;
  const [report, setReport] = useState<TypeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const valid = INSIGHT_REPORT_TYPES.includes(type);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getInsightsTypeReport(type, istDateNow()));
    } catch (err: any) {
      setError(err?.message || 'Report unavailable');
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => { if (valid) void load(); }, [load, valid]);

  const topScalars = useMemo(() => {
    if (!report) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(report)) {
      if (META_KEYS.has(k)) continue;
      if (v != null && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  }, [report]);

  const label = TYPE_LABELS[type] ?? type;

  if (!valid) {
    return (
      <div className="space-y-3">
        <InsightHeader title={`Report · ${type}`} subtitle="Unknown report type" />
        <p className="text-sm text-muted-foreground">Valid report types:</p>
        <div className="flex flex-wrap gap-1.5">
          {INSIGHT_REPORT_TYPES.map((t) => (
            <ChipButton key={t} active={false} onClick={() => { window.location.href = `/data-saver/insights/reports/${t}`; }}>
              {TYPE_LABELS[t]}
            </ChipButton>
          ))}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <InsightHeader title={`${label} Report`} subtitle={`Real-time ${type} report for today (IST)`} />
        <div className="py-20 text-center text-xs text-muted-foreground">Loading report…</div>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="space-y-3">
        <InsightHeader title={`${label} Report`} />
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button className="ml-3 text-xs underline" onClick={load}>Retry</button>
        </div>
      </div>
    );
  }

  const kvs = scalarsToKV(topScalars);

  return (
    <div className="space-y-3 pb-16">

      <InsightHeader
        title={`${label} Report`}
        subtitle={report?.reportDate ? `${report.reportDate} (IST) · real aggregation` : 'Real-time report'}
        tone={TYPE_ACCENT[type]}
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
          <>
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Type</span>
            {INSIGHT_REPORT_TYPES.map((t) => (
              <ChipButton key={t} active={t === type} onClick={() => { window.location.href = `/data-saver/insights/reports/${t}`; }}>
                {TYPE_LABELS[t]}
              </ChipButton>
            ))}
          </>
        }
      />

      {report?.error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {String(report.error)}
          <button className="ml-3 text-xs underline" onClick={load}>Retry</button>
        </div>
      ) : (
        <>
          {/* Headline numbers — the first four scalars as tiles, the rest as KV. */}
          <TileGrid cols={4}>
            {kvs.slice(0, 4).map((kv, i) => (
              <Tile
                key={kv.key} icon={FileBarChart}
                title={kv.key}
                accent={['error', 'fail'].some((s) => kv.key.toLowerCase().includes(s)) ? 'danger' : i === 0 ? 'teal' : 'slate'}
                hero={kv.value} heroLabel="REPORT VALUE"
                heroTone={kv.tone}
                keyRows={kvs.slice(4, 8).map((k) => ({ label: k.key, value: k.value, tone: k.tone }))}
                detailRows={kvs.slice(8, 14).map((k) => ({ label: k.key, value: k.value, tone: k.tone }))}
                note={`generated ${fmtTime((report?.generatedAt as string) ?? null)} IST`}
              />
            ))}
          </TileGrid>

          {kvs.length > 4 && (
            <SectionCard title="All Reported Values" icon={FileBarChart} className="border-t-2 border-t-teal-500">
              <KVBlock items={kvs} cols={4} verify="type-kv" />
            </SectionCard>
          )}

          {/* Domain blocks */}
          {type === 'websocket' && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <SectionCard title="Live WebSocket" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.live))} cols={2} /></SectionCard>
              <SectionCard title="Daily WebSocket" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.daily))} cols={2} /></SectionCard>
            </div>
          )}
          {type === 'tick' && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <SectionCard title="Tick Summary" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.summary))} cols={2} /></SectionCard>
              {Array.isArray(report?.activeSymbolsLive) && report.activeSymbolsLive.length > 0 && (
                <SectionCard title={`Active Symbols (live) · ${report.activeSymbolsLive.length}`} icon={FileBarChart}>
                  <div className="flex flex-wrap gap-1" data-verify="active-symbols-live">
                    {(report.activeSymbolsLive as string[]).map((s) => (
                      <span key={s} className="rounded border border-border/60 px-1.5 py-0.5 text-[9px]">{s}</span>
                    ))}
                  </div>
                </SectionCard>
              )}
            </div>
          )}
          {type === 'quality' && <SectionCard title="Data Quality" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.quality))} cols={3} /></SectionCard>}
          {type === 'api' && <SectionCard title="API Telemetry" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.api))} cols={3} /></SectionCard>}
          {type === 'persistence' && <SectionCard title="Persistence" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.persistence))} cols={2} /></SectionCard>}
          {type === 'errors' && (
            <SectionCard title="Error Groups" icon={FileBarChart}>
              <StatusBadge status={countTone(report?.totalGroups ?? null)} label={`${fmtCount(report?.totalGroups ?? null)} error groups`} />
            </SectionCard>
          )}
          {type === 'system' && <SectionCard title="System State" icon={FileBarChart}><KVBlock items={scalarsToKV(pickScalars(report?.state))} cols={3} /></SectionCard>}

          {/* Records */}
          <SectionCard title="Records" icon={FileBarChart} className="border-t-2 border-t-orange-500">
            <SectionHeading>{label} records</SectionHeading>
            <div className="mt-1.5">
              {type === 'websocket' && (
                <GenericTable rows={report?.connections as Record<string, any>[] | Record<string, any>}
                  cols={['connection_id', 'status', 'connected_at', 'disconnected_at', 'duration_sec', 'messages_received', 'ticks_received', 'error_count']} />
              )}
              {type === 'websocket' && (
                <GenericTable rows={report?.events as Record<string, any>[]} cols={['timestamp', 'event_type', 'severity', 'message']} />
              )}
              {type === 'tick' && (
                <GenericTable rows={report?.telemetry as Record<string, any>[]} cols={['timestamp', 'received', 'written', 'errors', 'ticksPerSecond', 'feedLatencyMs']} />
              )}
              {type === 'quality' && (
                <GenericTable rows={report?.issues as Record<string, any>[]} cols={['id', 'severity', 'status', 'title', 'dimension', 'occurrences', 'lastSeen']} />
              )}
              {type === 'api' && (
                <GenericTable rows={report?.series as Record<string, any>[]} cols={['timestamp', 'requests', 'errors', 'avgLatencyMs']} />
              )}
              {type === 'errors' && (
                <GenericTable rows={report?.groups as Record<string, any>[]} cols={['category', 'eventType', 'reasonCode', 'occurrences', 'severity', 'resolved', 'lastSeen']} />
              )}
              {type === 'errors' && (
                <GenericTable rows={report?.events as Record<string, any>[]} cols={['timestamp', 'severity', 'category', 'message']} />
              )}
              {type === 'persistence' && (
                <GenericTable rows={report?.pipelineEvents as Record<string, any>[]} cols={['timestamp', 'event_type', 'severity', 'message']} />
              )}
              {type === 'system' && (
                <GenericTable rows={report?.telemetry as Record<string, any>[]} cols={['timestamp', 'received', 'written', 'errors', 'wsMessagesReceived']} />
              )}
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Small generic record table                                                  */
/* ------------------------------------------------------------------------- */

function GenericTable({ rows, cols }: { rows: Record<string, any>[] | Record<string, any> | undefined; cols: string[] }) {
  const data: Record<string, any>[] = useMemo(() => {
    if (!rows) return [];
    if (Array.isArray(rows)) return rows.filter(Boolean);
    // websocket reports put connection rows under `.records`
    if (Array.isArray((rows as any).records)) return (rows as any).records.filter(Boolean);
    return [];
  }, [rows]);

  const columns: Column<Record<string, any>>[] = cols.map((c) => ({
    key: c,
    label: c.replace(/_/g, ' '),
    align: 'right' as const,
    render: (r: Record<string, any>) => {
      const raw = r[c];
      if (raw == null) return <span className="text-muted-foreground">—</span>;
      if (Array.isArray(raw)) return <span className="text-muted-foreground">[{raw.length}]</span>;
      if (typeof raw === 'object') return <span className="text-muted-foreground">…</span>;
      if (c === 'severity' || c === 'status' || c === 'resolved') {
        return <StatusBadge status={c === 'resolved' ? (raw ? 'success' : 'warning') : severityState(String(raw))} label={String(raw)} />;
      }
      return String(raw);
    },
  }));

  return (
    <div className="mb-2 last:mb-0">
      <DataTable
        columns={columns} rows={data} rowId={(r, i) => String(r.record_id ?? r.connection_id ?? r.id ?? i)}
        maxHeight={260} verify="type-records"
        footer={<span>showing {data.length}</span>}
        empty={<p className="py-4 text-center text-[11px] text-muted-foreground">No records in this report.</p>}
      />
    </div>
  );
}