'use client';

// ERROR CENTER — recurring errors grouped by (category, event_type, reason_code,
// component) and correlated with recovery evidence. Every group is derived from
// REAL ledger events including the resolved flag; nothing is fabricated.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertOctagon, ArrowRight, ShieldCheck } from 'lucide-react';
import {
  InsightHeader, RefreshButton, ChipButton, Tile, TileGrid, SectionCard,
  StatusBadge, StatusStrip, DataTable, type Column,
  countTone,
} from '@/components/insights/insights-ui';
import {
  getInsightsErrors, useInsightsStream,
  severityState, istDateNow, fmtAgo, fmtCount,
} from '@/lib/insights';
import type { ErrorGroup, InsightStreamFrame } from '@/lib/insights';

const RANGES: { key: string; label: string; hours?: number }[] = [
  { key: '1h', label: '1H', hours: 1 },
  { key: '6h', label: '6H', hours: 6 },
  { key: '24h', label: '24H', hours: 24 },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7D', hours: 168 },
];

export default function ErrorCenterPage() {
  const [groups, setGroups] = useState<ErrorGroup[]>([]);
  const [range, setRange] = useState('24h');
  const [includeWarnings, setIncludeWarnings] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const win = useMemo(() => {
    const opt = RANGES.find((r) => r.key === range) ?? RANGES[2];
    return opt.key === 'today' ? { marketDate: istDateNow() } : { rangeHours: opt.hours };
  }, [range]);

  const load = useCallback(async (silent = false) => {
    if (silent) return;
    setLoading(true);
    try {
      setGroups((await getInsightsErrors(win.rangeHours, win.marketDate, includeWarnings)).groups);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load error groups');
    } finally {
      setLoading(false);
    }
  }, [win, includeWarnings]);

  useEffect(() => { void load(); }, [load]);

  const onStreamFrame = useCallback((frame: InsightStreamFrame) => {
    if (frame.type === 'insight_event' || frame.type === 'incident_created' || frame.type === 'incident_resolved') {
      void load(true);
    }
  }, [load]);

  const { connected } = useInsightsStream(onStreamFrame);

  const open = groups.filter((g) => !g.resolved).length;
  const resolved = groups.filter((g) => g.resolved).length;
  const occurrences = groups.reduce((n, g) => n + (g.occurrences ?? 0), 0);
  const worst = groups.reduce<ErrorGroup | null>((acc, g) => {
    if (!acc) return g;
    return (g.occurrences ?? 0) > (acc.occurrences ?? 0) ? g : acc;
  }, null);

  const byCategory = useMemo(() => {
    const m = new Map<string, ErrorGroup[]>();
    for (const g of groups) {
      const k = String(g.category || 'uncategorised');
      const arr = m.get(k); if (arr) arr.push(g); else m.set(k, [g]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [groups]);

  const columns: Column<ErrorGroup>[] = [
    {
      key: 'state', label: 'State', render: (g) => (
        g.resolved
          ? <StatusBadge status="success" label="resolved" />
          : <StatusBadge status={severityState(g.severity)} label={g.severity || 'error'} />
      ),
    },
    {
      key: 'type', label: 'Error', render: (g) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium">{g.eventType || '—'}</span>
          {g.sampleMessage && <span className="block truncate text-[9px] text-muted-foreground">{g.sampleMessage}</span>}
        </span>
      ),
    },
    { key: 'cat', label: 'Category', compactHide: true, render: (g) => <span className="text-[9px] uppercase text-muted-foreground">{g.category || '—'}</span> },
    { key: 'occ', label: 'Occurrences', align: 'right', render: (g) => <span className={countTone(g.occurrences, 2, 5) === 'danger' ? 'text-destructive' : ''}>{fmtCount(g.occurrences)}</span> },
    { key: 'rc', label: 'Reason', compactHide: true, render: (g) => <span className="text-[9px] text-muted-foreground">{g.reasonCode || '—'}</span> },
    { key: 'comp', label: 'Component', compactHide: true, render: (g) => <span className="text-[9px] text-muted-foreground">{g.component || g.source || '—'}</span> },
    { key: 'first', label: 'First', align: 'right', compactHide: true, render: (g) => <span className="text-[9px] text-muted-foreground">{fmtAgo(g.firstSeen)}</span> },
    { key: 'last', label: 'Last', align: 'right', render: (g) => <span className="text-[9px]">{fmtAgo(g.lastSeen)}</span> },
    {
      key: 'go', label: '', align: 'right', render: (g) => (
        <Link href={`/data-saver/insights/errors/${g.groupId}`} className="inline-flex items-center gap-1 whitespace-nowrap text-[9px] text-orange-500 hover:underline">
          Open <ArrowRight className="h-2.5 w-2.5" />
        </Link>
      ),
    },
  ];

  if (error && groups.length === 0) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Error Center" />
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
        title="Error Center"
        subtitle="Recurring errors grouped by fingerprint and correlated with recovery evidence"
        live={connected}
        tone={open > 0 ? 'danger' : 'teal'}
        actions={<RefreshButton onClick={() => void load()} busy={loading} />}
        badges={
          <>
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Window</span>
            {RANGES.map((r) => <ChipButton key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>{r.label}</ChipButton>)}
            <ChipButton active={includeWarnings} onClick={() => setIncludeWarnings((v) => !v)}>
              {includeWarnings ? 'incl. warnings' : 'errors only'}
            </ChipButton>
            <span className="ml-auto flex flex-wrap items-center gap-1.5">
              {open > 0 && <StatusBadge status="danger" label={`${fmtCount(open)} open`} />}
              {resolved > 0 && <StatusBadge status="success" label={`${fmtCount(resolved)} recovered`} />}
              <StatusBadge status="neutral" label={`${fmtCount(groups.length || null)} groups · ${fmtCount(occurrences)} occurrences`} />
            </span>
          </>
        }
      />

      <TileGrid cols={4}>
        <Tile
          icon={AlertOctagon} title="Open Groups" accent={open > 0 ? 'danger' : 'teal'}
          hero={fmtCount(open)} heroLabel="UNRESOLVED"
          heroTone={countTone(open, 1, 1)}
          keyRows={[
            { label: 'Recovered', value: fmtCount(resolved), tone: 'success' },
            { label: 'Total groups', value: fmtCount(groups.length || null) },
          ]}
          detailRows={[{ label: 'Occurrences', value: fmtCount(occurrences) }]}
          note="resolved flag from recovery evidence"
        />
        <Tile
          icon={ShieldCheck} title="Occurrences" accent="amber"
          hero={fmtCount(occurrences)} heroLabel="IN WINDOW"
          keyRows={[
            { label: 'Per group avg', value: groups.length ? String(Math.round(occurrences / groups.length)) : '—' },
            { label: 'Categories', value: String(byCategory.length) },
          ]}
          note="sum of group occurrence counters"
        />
        {byCategory.slice(0, 2).map(([cat, list]) => (
          <Tile
            key={cat} icon={AlertOctagon} title={cat} accent="slate"
            hero={String(list.length)} heroLabel="GROUPS"
            keyRows={list.slice(0, 3).map((g) => ({ label: g.eventType || '—', value: fmtCount(g.occurrences) }))}
            detailRows={list.slice(3).map((g) => ({ label: g.eventType || '—', value: fmtCount(g.occurrences) }))}
          />
        ))}
      </TileGrid>

      <SectionCard title={`Error Groups · ${fmtCount(groups.length || null)}`} icon={AlertOctagon} className="border-t-2 border-t-rose-500">
        <DataTable
          columns={columns} rows={groups} rowId={(g) => g.groupId}
          maxHeight={420} onRowClick={(g) => { window.location.href = `/data-saver/insights/errors/${g.groupId}`; }}
          verify="error-groups"
          footer={<><span>showing {groups.length}</span><span>window {range}</span><span>worst: {worst?.eventType ?? '—'}</span></>}
          empty={
            <div className="py-8 text-center">
              <ShieldCheck className="mx-auto mb-2 h-6 w-6 text-emerald-500" />
              <p className="text-sm font-medium">No recurring errors</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Error groups appear when failures are detected in this window</p>
            </div>
          }
        />
      </SectionCard>

      <StatusStrip>
        <span className="text-[10px] text-muted-foreground">
          Every group is a real ledger fingerprint (category · event_type · reason_code · component). A group flips to
          <span className="text-foreground"> resolved </span>
          only when recovery evidence arrives on the event ledger — nothing is cleared manually.
        </span>
      </StatusStrip>
    </div>
  );
}