'use client';

// RECENT ACTIVITY — chronological ledger feed from /api/data-saver/insights/events.
// Every event is REAL: written by the backend event ledger as the system runs.
// Supports window / category / severity / free-text filters, pagination and CSV
// export of the currently applied window.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Download, Search, X } from 'lucide-react';
import {
  InsightHeader, RefreshButton, ChipButton, Tile, TileGrid, SectionCard,
  StatusBadge, DataTable, type Column,
} from '@/components/insights/insights-ui';
import {
  getInsightsEvents, exportInsightsEvents, useInsightsStream,
  fmtAgo, fmtCount, fmtDateTime, severityState,
} from '@/lib/insights';
import type { LedgerEvent, InsightStreamFrame } from '@/lib/insights';
import { useToast } from '@/hooks/use-toast';

const RANGES: { key: string; label: string; hours?: number }[] = [
  { key: '1h', label: '1H', hours: 1 },
  { key: '6h', label: '6H', hours: 6 },
  { key: '24h', label: '24H', hours: 24 },
  { key: '7d', label: '7D', hours: 168 },
  { key: '30d', label: '30D', hours: 720 },
];

const CATEGORIES = [
  'WEBSOCKET', 'MARKET_DATA', 'TICKS', 'DATA_QUALITY', 'PERSISTENCE', 'DATABASE',
  'PIPELINE', 'SCHEDULER', 'MARKET', 'AUTHENTICATION', 'SUBSCRIPTION', 'ALERT',
  'NOTIFICATION', 'SYSTEM', 'PWA', 'SETTINGS',
];

const SEVERITIES = ['critical', 'error', 'warning', 'info', 'success'];
const PAGE = 50;

export default function RecentActivityPage() {
  const { toast } = useToast();
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [range, setRange] = useState('24h');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => {
    const opt = RANGES.find((r) => r.key === range) ?? RANGES[2];
    return {
      rangeHours: opt.hours,
      category: category || undefined,
      severity: severity || undefined,
      search: query || undefined,
      limit: PAGE,
    };
  }, [range, category, severity, query]);

  const load = useCallback(async (offset = 0, append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const res = await getInsightsEvents({ ...params, offset });
      setTotal(res.total);
      setEvents((prev) => append
        ? [...prev, ...res.events.filter((e) => !prev.some((p) => p.event_id === e.event_id))]
        : res.events);
      setError(null);
    } catch (err: any) {
      if (!append) setError(err?.message || 'Failed to load events');
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [params]);

  useEffect(() => { void load(); }, [load]);

  const onStreamFrame = useCallback((frame: InsightStreamFrame) => {
    // Push a new real event to the top of the feed without a full reload.
    if (frame.type !== 'insight_event') return;
    setEvents((prev) => {
      const ev: LedgerEvent = {
        event_id: frame.event_id,
        event: frame.event_type,
        event_type: frame.event_type,
        category: frame.category,
        severity: frame.severity,
        source: frame.source,
        status: frame.status,
        message: frame.message,
        timestamp: frame.timestamp,
        market_date: frame.market_date,
      };
      return [ev, ...prev.filter((e) => e.event_id !== ev.event_id)].slice(0, PAGE);
    });
    setTotal((t) => (t === 0 ? 1 : t + 1));
  }, []);

  const { connected } = useInsightsStream(onStreamFrame);

  const handleExport = useCallback(async () => {
    try {
      const res = await exportInsightsEvents({
        format: 'csv', limit: 2000, range_hours: params.rangeHours,
        category: params.category, severity: params.severity,
      });
      const blob = new Blob([res.content], { type: res.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `data-saver-events-last${params.rangeHours}h.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: 'Export failed', description: err?.message || 'Could not export events', variant: 'destructive' });
    }
  }, [params, toast]);

  const stats = useMemo(() => {
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let withSymbol = 0;
    for (const e of events) {
      const s = String(e.severity || 'info');
      bySeverity[s] = (bySeverity[s] ?? 0) + 1;
      const c = String(e.category || 'uncategorised');
      byCategory[c] = (byCategory[c] ?? 0) + 1;
      if (e.symbol) withSymbol += 1;
    }
    return { bySeverity, byCategory, withSymbol };
  }, [events]);

  const columns: Column<LedgerEvent>[] = [
    { key: 'time', label: 'Time', render: (e) => <span className="font-mono text-[9px] text-muted-foreground">{fmtDateTime(e.timestamp)}</span> },
    { key: 'sev', label: 'Severity', render: (e) => <StatusBadge status={severityState(e.severity)} label={e.severity || 'info'} /> },
    {
      key: 'msg', label: 'Event', render: (e) => (
        <span className="block min-w-0">
          <span className="block truncate">{e.message || e.event_type || e.event || '—'}</span>
        </span>
      ),
    },
    { key: 'cat', label: 'Category', compactHide: true, render: (e) => <span className="text-[9px] uppercase text-muted-foreground">{e.category || '—'}</span> },
    { key: 'src', label: 'Source', compactHide: true, render: (e) => <span className="text-[9px] text-muted-foreground">{e.source || '—'}</span> },
    { key: 'sym', label: 'Symbol', compactHide: true, render: (e) => (e.symbol ? <span className="rounded border border-border/60 px-1 text-[9px]">{e.symbol}</span> : <span className="text-[9px] text-muted-foreground">—</span>) },
    { key: 'rc', label: 'Reason', compactHide: true, render: (e) => <span className="text-[9px] text-muted-foreground">{e.reason_code || '—'}</span> },
    { key: 'ago', label: 'Age', align: 'right', render: (e) => <span className="text-[9px] text-muted-foreground">{fmtAgo(e.timestamp)}</span> },
  ];

  if (error && events.length === 0) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Recent Activity" />
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
        title="Recent Activity"
        subtitle="Chronological ledger of every real event across the Data Saver"
        live={connected}
        tone="sky"
        actions={
          <>
            <button
              type="button"
              onClick={handleExport}
              title="Export the current filtered window as CSV"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
            <RefreshButton onClick={() => void load()} busy={loading} label="Refresh the feed" />
          </>
        }
        badges={
          <>
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Window</span>
            {RANGES.map((r) => <ChipButton key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>{r.label}</ChipButton>)}
            <StatusBadge status="neutral" label={loading ? 'Loading…' : `${fmtCount(total)} events`} />
            {(category || severity || query) && (
              <button
                type="button"
                onClick={() => { setCategory(''); setSeverity(''); setSearch(''); setQuery(''); }}
                className="ml-auto inline-flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground"
              >
                <X className="h-2.5 w-2.5" /> Clear filters
              </button>
            )}
          </>
        }
      />

      {/* Filters */}
      <SectionCard title="Filters" icon={Search} className="border-t-2 border-t-sky-500">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">
            Category
            <select
              value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category"
              className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-[10px] focus:outline-none"
            >
              <option value="">All</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <label className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground">
            Severity
            <select
              value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Filter by severity"
              className="h-7 rounded-md border border-border/60 bg-background px-1.5 text-[10px] focus:outline-none"
            >
              <option value="">All</option>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <form
            className="relative ml-1"
            onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}
          >
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/60" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search message / id / symbol…"
              aria-label="Search ledger"
              className="h-7 w-56 rounded-md border border-border/60 bg-background pl-6 pr-2 text-[10px] focus:border-teal-500/50 focus:outline-none"
            />
          </form>
          {query && <span className="text-[9px] text-muted-foreground">q = “{query}”</span>}
        </div>
      </SectionCard>

      {/* Windowed view of the loaded rows — real, never extrapolated. */}
      <TileGrid cols={4}>
        <Tile
          icon={Activity} title="Loaded" accent="sky"
          hero={fmtCount(events.length || null)} heroLabel="ROWS IN FEED"
          keyRows={[
            { label: 'Total in window', value: fmtCount(total) },
            { label: 'With symbol', value: fmtCount(stats.withSymbol || null) },
            { label: 'Page size', value: String(PAGE) },
          ]}
          note={`first ${events[0] ? fmtAgo(events[0].timestamp) : '—'} · last ${events[events.length - 1] ? fmtAgo(events[events.length - 1].timestamp) : '—'}`}
        />
        {Object.entries(stats.bySeverity).slice(0, 3).map(([sev, n]) => (
          <Tile
            key={sev} icon={Activity} title={sev} accent={sev === 'critical' || sev === 'error' ? 'danger' : sev === 'warning' ? 'amber' : 'slate'}
            hero={fmtCount(n)} heroLabel="IN THIS PAGE"
            heroTone={severityState(sev)}
            keyRows={Object.entries(stats.byCategory).slice(0, 3).map(([c, v]) => ({ label: c, value: fmtCount(v) }))}
            detailRows={Object.entries(stats.byCategory).slice(3).map(([c, v]) => ({ label: c, value: fmtCount(v) }))}
          />
        ))}
      </TileGrid>

      <SectionCard title="Event Feed" icon={Activity} className="border-t-2 border-t-sky-500">
        <DataTable
          columns={columns} rows={events} rowId={(e, i) => e.event_id || `${e.timestamp}-${i}`}
          maxHeight={520} verify="activity-feed"
          footer={
            <>
              <span>showing {events.length} of {fmtCount(total)}</span>
              <span>window {range}</span>
              <span>newest first</span>
              <span>source: insights/events</span>
            </>
          }
          empty={
            <div className="py-8 text-center">
              <Search className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
              <p className="text-sm font-medium">No events match</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Try widening the window or clearing filters</p>
            </div>
          }
        />

        {events.length < total && events.length > 0 && (
          <div className="mt-2 flex justify-center">
            <button
              type="button" disabled={loadingMore} onClick={() => void load(events.length, true)}
              className="rounded-md border border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {loadingMore ? 'Loading…' : `Load more (${fmtCount(events.length)} of ${fmtCount(total)})`}
            </button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}