'use client';

// ATTENTION REQUIRED — open incidents, unresolved error groups, persistence
// failures and feed disconnects. Every item comes from REAL backend state
// (/api/data-saver/insights/attention); nothing is fabricated.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Wrench } from 'lucide-react';
import {
  InsightHeader, RefreshButton, Tile, TileGrid, SectionCard, SectionHeading,
  StatusBadge, StatusStrip, DataTable, type Column,
} from '@/components/insights/insights-ui';
import {
  getInsightsAttention, useInsightsStream,
  fmtCount, fmtAgo, fmtDateTime, severityState,
} from '@/lib/insights';
import type { AttentionResponse, InsightStreamFrame } from '@/lib/insights';

type Item = NonNullable<AttentionResponse['items']>[number];

export default function AttentionRequiredPage() {
  const [data, setData] = useState<AttentionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await getInsightsAttention());
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load attention status');
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

  const items = useMemo(() => data?.items ?? [], [data]);
  const count = data ? data.critical + data.warning : null;

  /** Group by the item `kind` so a mixed list reads as buckets, not one wall. */
  const byKind = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const k = String(it.kind || 'item');
      const arr = m.get(k);
      if (arr) arr.push(it); else m.set(k, [it]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  const oldest = useMemo(
    () => items.reduce<string | null | undefined>((acc, i) => {
      if (!i.since) return acc;
      if (!acc) return i.since;
      return new Date(i.since) < new Date(acc) ? i.since : acc;
    }, null),
    [items],
  );
  const newest = useMemo(
    () => items.reduce<string | null | undefined>((acc, i) => {
      if (!i.since) return acc;
      if (!acc) return i.since;
      return new Date(i.since) > new Date(acc) ? i.since : acc;
    }, null),
    [items],
  );

  const columns: Column<Item>[] = [
    {
      key: 'sev', label: 'Severity', render: (it) => (
        <StatusBadge status={severityState(it.severity)} label={it.severity || 'info'} />
      ),
    },
    {
      key: 'title', label: 'Item', render: (it) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{it.title || '—'}</span>
          {it.message && <span className="block truncate text-[9px] text-muted-foreground">{it.message}</span>}
        </span>
      ),
    },
    { key: 'kind', label: 'Kind', compactHide: true, render: (it) => <span className="text-[9px] uppercase text-muted-foreground">{it.kind || 'item'}</span> },
    { key: 'since', label: 'Since', align: 'right', render: (it) => <span className="text-[9px] text-muted-foreground">{fmtDateTime(it.since)}</span> },
    { key: 'ago', label: 'Age', align: 'right', render: (it) => <span className="text-[9px]">{fmtAgo(it.since)}</span> },
    {
      key: 'go', label: '', align: 'right', render: (it) => (
        it.groupId ? (
          <Link
            href={`/data-saver/insights/errors/${it.groupId}`}
            className="inline-flex items-center gap-1 whitespace-nowrap text-[9px] text-orange-500 hover:underline"
          >
            Group <ArrowRight className="h-2.5 w-2.5" />
          </Link>
        ) : <span className="text-[9px] text-muted-foreground">—</span>
      ),
    },
  ];

  if (error && !data) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Attention Required" />
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
        title="Attention Required"
        subtitle="Open incidents, unresolved error groups, tick-persistence write failures and WebSocket disconnects"
        live={connected}
        tone={count && count > 0 ? 'amber' : 'teal'}
        actions={<RefreshButton onClick={() => void load()} busy={loading} />}
        badges={
          <>
            <StatusBadge status={count && count > 0 ? 'warning' : 'success'} label={count && count > 0 ? `${fmtCount(count)} require attention` : 'All clear'} />
            {data && data.critical > 0 && <StatusBadge status="danger" label={`${fmtCount(data.critical)} critical`} />}
            {data && data.warning > 0 && <StatusBadge status="warning" label={`${fmtCount(data.warning)} warnings`} />}
          </>
        }
      />

      {loading && !data ? (
        <div className="py-20 text-center text-xs text-muted-foreground">Checking live attention status…</div>
      ) : (
        <>
          <TileGrid cols={4}>
            <Tile
              icon={AlertTriangle} title="Total Open" accent={count && count > 0 ? 'amber' : 'teal'}
              hero={fmtCount(count)} heroLabel="ITEMS"
              heroTone={count && count > 0 ? 'warning' : 'success'}
              keyRows={[
                { label: 'Critical', value: fmtCount(data?.critical ?? null), tone: (data?.critical ?? 0) > 0 ? 'danger' : 'success' },
                { label: 'Warning', value: fmtCount(data?.warning ?? null), tone: (data?.warning ?? 0) > 0 ? 'warning' : 'success' },
                { label: 'Kinds', value: byKind.length ? String(byKind.length) : '—' },
              ]}
              note="/api/data-saver/insights/attention"
            />
            <Tile
              icon={Wrench} title="Oldest Item" accent="rose"
              hero={oldest ? fmtAgo(oldest) : '—'} heroUnit={oldest ? 'old' : undefined} heroLabel="SINCE"
              keyRows={[
                { label: 'When', value: oldest ? fmtDateTime(oldest) : '—' },
                { label: 'Newest', value: newest ? fmtAgo(newest) : '—' },
              ]}
              note="oldest unresolved item"
            />
            {byKind.slice(0, 2).map(([kind, list]) => (
              <Tile
                key={kind} icon={Wrench} title={labelizeKind(kind)} accent="slate"
                hero={String(list.length)} heroLabel="ITEMS OF THIS KIND"
                heroTone="neutral"
                keyRows={list.slice(0, 3).map((it) => ({ label: it.title || '—', value: fmtAgo(it.since) }))}
                detailRows={list.slice(3).map((it) => ({ label: it.title || '—', value: fmtAgo(it.since) }))}
              />
            ))}
          </TileGrid>

          <SectionCard title={`Attention Items · ${fmtCount(items.length || null)}`} icon={AlertTriangle} className="border-t-2 border-t-amber-500">
            {items.length === 0 ? (
              <div className="py-8 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
                <p className="text-sm font-medium">Nothing requires attention</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  No open incidents, unresolved errors or feed failures
                </p>
              </div>
            ) : (
              <DataTable
                columns={columns} rows={items} rowId={(it, i) => it.incidentId || it.groupId || String(i)}
                maxHeight={420} verify="attention-items"
                footer={<><span>showing {items.length}</span><span>kinds: {byKind.map(([k, l]) => `${k}(${l.length})`).join(' ')}</span></>}
              />
            )}
          </SectionCard>

          <SectionHeading>How this is computed</SectionHeading>
          <StatusStrip>
            <span className="text-[10px] text-muted-foreground">
              Items are computed from live system state: open incidents, unresolved error groups in the last 24h,
              tick-persistence write failures and WebSocket disconnects. A resolved item (recovery evidence on the
              event ledger) is removed automatically — nothing is cleared manually or fabricated.
            </span>
          </StatusStrip>
        </>
      )}
    </div>
  );
}

function labelizeKind(kind: string): string {
  return kind.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toUpperCase();
}