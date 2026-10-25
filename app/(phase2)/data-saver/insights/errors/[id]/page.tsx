'use client';

// ERROR GROUP DETAIL — one recurring error group plus the REAL ledger events
// behind it (from /api/data-saver/insights/errors/{groupId}).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertOctagon, ArrowLeft, Fingerprint } from 'lucide-react';
import {
  InsightHeader, RefreshButton, Tile, TileGrid, SectionCard,
  StatusBadge, DataTable, type Column, KVBlock, scalarsToKV,
  countTone,
} from '@/components/insights/insights-ui';
import {
  getInsightsErrorGroup, useInsightsStream,
  fmtAgo, fmtCount, fmtDateTime, severityState,
} from '@/lib/insights';
import type { ErrorGroupDetailResponse, InsightStreamFrame, LedgerEvent } from '@/lib/insights';

export default function ErrorGroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ErrorGroupDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) return;
    setLoading(true);
    try {
      setData(await getInsightsErrorGroup(id, 24));
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load error group');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const onStreamFrame = useCallback((frame: InsightStreamFrame) => {
    if (frame.type === 'insight_event' || frame.type === 'incident_created' || frame.type === 'incident_resolved') {
      void load(true);
    }
  }, [load]);

  const { connected } = useInsightsStream(onStreamFrame);

  const g = data?.group;
  const occurrences = data?.occurrences ?? [];

  const columns: Column<LedgerEvent>[] = [
    { key: 'time', label: 'Time', render: (e) => <span className="font-mono text-[9px] text-muted-foreground">{fmtDateTime(e.timestamp)}</span> },
    { key: 'sev', label: 'Severity', render: (e) => <StatusBadge status={severityState(e.severity)} label={e.severity || 'info'} /> },
    {
      key: 'msg', label: 'Message', render: (e) => (
        <span className="block min-w-0">
          <span className="block truncate">{e.message || e.event || '—'}</span>
          {e.details && <span className="block truncate text-[9px] text-muted-foreground">{e.details}</span>}
        </span>
      ),
    },
    { key: 'cat', label: 'Category', compactHide: true, render: (e) => <span className="text-[9px] uppercase text-muted-foreground">{e.category || '—'}</span> },
    { key: 'rc', label: 'Reason', compactHide: true, render: (e) => <span className="text-[9px] text-muted-foreground">{e.reason_code || '—'}</span> },
    { key: 'src', label: 'Source', compactHide: true, render: (e) => <span className="text-[9px] text-muted-foreground">{e.source || '—'}</span> },
    { key: 'dur', label: 'Dur', align: 'right', render: (e) => (e.duration_ms == null ? '—' : <span>{fmtCount(e.duration_ms)} ms</span>) },
    { key: 'ago', label: 'Age', align: 'right', render: (e) => <span className="text-[9px] text-muted-foreground">{fmtAgo(e.timestamp)}</span> },
  ];

  if (error && !data) {
    return (
      <div className="space-y-3">
        <InsightHeader title={g?.eventType || 'Error Group'} />
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
        title={g?.eventType || 'Error Group'}
        subtitle="One recurring error group with the real ledger events behind it"
        live={connected}
        tone={g?.resolved ? 'teal' : 'danger'}
        actions={
          <>
            <Link
              href="/data-saver/insights/errors"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Error Center
            </Link>
            <RefreshButton onClick={() => void load()} busy={loading} />
          </>
        }
        badges={
          g && (
            <>
              <StatusBadge status={g.resolved ? 'success' : severityState(g.severity)} label={g.resolved ? 'RESOLVED' : String(g.severity || 'open').toUpperCase()} />
              {g.category && <StatusBadge status="neutral" label={g.category.toUpperCase()} />}
              {g.component && <StatusBadge status="info" label={g.component.toUpperCase()} />}
            </>
          )
        }
      />

      {loading && !data ? (
        <div className="py-20 text-center text-xs text-muted-foreground">Loading error group…</div>
      ) : data && g ? (
        <>
          <TileGrid cols={4}>
            <Tile
              icon={AlertOctagon} title="Occurrences" accent={g.resolved ? 'teal' : 'danger'}
              hero={fmtCount(g.occurrences)} heroLabel="TOTAL SEEN"
              heroTone={countTone(g.occurrences, 2, 5)}
              keyRows={[
                { label: 'In 24h window', value: fmtCount(data.count) },
                { label: 'State', value: g.resolved ? 'Resolved' : 'Open', tone: g.resolved ? 'success' : 'warning' },
              ]}
              note="grouped fingerprint counter"
            />
            <Tile
              icon={AlertOctagon} title="Severity" accent="amber"
              hero={String(g.severity || '—').toUpperCase()} heroLabel="LEVEL"
              heroTone={severityState(g.severity)}
              keyRows={[
                { label: 'Category', value: g.category || '—' },
                { label: 'Reason code', value: g.reasonCode || '—' },
                { label: 'Component', value: g.component || '—' },
              ]}
              detailRows={[{ label: 'Source', value: g.source || '—' }]}
              note="classification from the event"
            />
            <Tile
              icon={AlertOctagon} title="First Seen" accent="sky"
              hero={fmtAgo(g.firstSeen)} heroUnit="ago" heroLabel="SINCE"
              keyRows={[
                { label: 'When', value: fmtDateTime(g.firstSeen) },
                { label: 'Last seen', value: fmtAgo(g.lastSeen) },
                { label: 'Span', value: spanOf(g.firstSeen, g.lastSeen) },
              ]}
              note="ledger timestamps"
            />
            <Tile
              icon={Fingerprint} title="Fingerprint" accent="slate"
              hero="sha256" heroLabel="HASH"
              keyRows={[
                { label: 'Group id', value: g.groupId },
              ]}
              detailRows={[{ label: 'Full hash', value: g.fingerprint }]}
              footer={<p className="truncate font-mono text-[8px] text-muted-foreground" title={g.fingerprint}>{g.fingerprint}</p>}
            />
          </TileGrid>

          {g.sampleMessage && (
            <SectionCard title="Latest Sample" icon={AlertOctagon} className="border-t-2 border-t-rose-500">
              <p className="font-mono text-[11px] leading-5" data-verify="sample-message">{g.sampleMessage}</p>
              {g.sampleDetails && <p className="mt-1 font-mono text-[10px] leading-5 text-muted-foreground">{g.sampleDetails}</p>}
              <p className="mt-1 text-[9px] text-muted-foreground">
                event {g.sampleEventId || '—'}
              </p>
            </SectionCard>
          )}

          <KVBlock
            title="Group Facts"
            items={scalarsToKV({
              event_type: g.eventType, category: g.category, reason_code: g.reasonCode,
              component: g.component, source: g.source, severity: g.severity, resolved: g.resolved,
              occurrences: g.occurrences,
            })}
            cols={4}
          />

          <SectionCard title={`Occurrences · ${fmtCount(occurrences.length || null)}`} icon={AlertOctagon} className="border-t-2 border-t-rose-500">
            <DataTable
              columns={columns} rows={occurrences} rowId={(e, i) => e.event_id || `${e.timestamp}-${i}`}
              maxHeight={400} verify="error-occurrences"
              footer={<><span>showing {occurrences.length} of {fmtCount(g.occurrences)}</span><span>window 24h</span></>}
              empty={<p className="py-8 text-center text-[11px] text-muted-foreground">No occurrences in this window.</p>}
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}

function spanOf(a?: string, b?: string): string {
  if (!a || !b) return '—';
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  if (!Number.isFinite(d) || d < 0) return '—';
  if (d < 60) return `${Math.round(d)} s`;
  if (d < 3600) return `${Math.round(d / 60)} m`;
  if (d < 86400) return `${(d / 3600).toFixed(1)} h`;
  return `${(d / 86400).toFixed(1)} d`;
}