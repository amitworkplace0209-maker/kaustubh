'use client';

// Data Saver — Data Insights overview.
//
// ONE authoritative request (/api/data-saver/insights/summary) drives the four
// intelligence sections, PLUS three live telemetry blocks that the backend
// already serves but nothing used to surface: /cards, /telemetry and
// /api-telemetry. Every figure is real backend state — a metric the backend
// reports as null renders as "—" and is never turned into 0.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity as ActivityIcon, AlertOctagon, AlertTriangle, ArrowRight, CalendarDays,
  CheckCircle2, Clock, Database, Gauge, ListFilter, Server, TrendingUp, Wifi,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  InsightHeader, RefreshButton, Tile, TileGrid, SectionCard, SectionHeading, StatusBadge,
  StatusStrip, SparkBars, DataTable, type Column, type UiTone,
  countTone, pctTone, val,
} from '@/components/insights/insights-ui';
import {
  getInsightsSummary, getInsightsEvents, getInsightsTelemetry, getInsightsApiTelemetry,
  getInsightsCards, useInsightsStream,
  fmtCount, fmtAgo, fmtTime, severityState,
} from '@/lib/insights';
import type {
  InsightsSummaryResponse, LedgerEvent, InsightStreamFrame,
  TelemetryPoint, ApiTelemetrySummary, CardsResponse,
} from '@/lib/insights';

/* ========================================================================== */
/* Card model                                                                  */
/* ========================================================================== */

type ToneKey = 'danger' | 'warning' | 'success' | 'sky' | 'violet' | 'teal' | 'amber' | 'slate';

interface InsightCard {
  id: string;
  href: string;
  title: string;
  description: string;
  icon: React.ElementType;
  accent: ToneKey;
  hero: string;
  heroUnit?: string;
  heroLabel: string;
  heroTone: UiTone;
  keyRows: { label: string; value: string; tone?: UiTone }[];
  detailRows: { label: string; value: string; tone?: UiTone }[];
  note: string;
}

function cardMeta(s: InsightsSummaryResponse): InsightCard[] {
  const gen = s.generatedAt;
  const lastEv = s.activity.lastEvent;

  return [
    {
      id: 'attention',
      href: '/data-saver/insights/attention',
      title: 'Attention Required',
      description: 'Open incidents, unresolved error groups and feed failures that need review.',
      icon: AlertTriangle,
      accent: s.attention.count > 0 ? 'amber' : 'teal',
      hero: fmtCount(s.attention.count),
      heroLabel: 'OPEN ITEMS',
      heroTone: s.attention.critical > 0 ? 'danger' : s.attention.count > 0 ? 'warning' : 'success',
      keyRows: [
        { label: 'Critical', value: fmtCount(s.attention.critical), tone: s.attention.critical > 0 ? 'danger' : 'success' },
        { label: 'Warning', value: fmtCount(s.attention.warning), tone: s.attention.warning > 0 ? 'warning' : 'success' },
        { label: 'Oldest', value: fmtAgo(s.attention.preview?.[0]?.since) },
      ],
      detailRows: [
        { label: 'Newest', value: fmtAgo(s.attention.preview?.[s.attention.preview.length - 1]?.since) },
        { label: 'Snapshot', value: fmtAgo(gen) },
      ],
      note: 'open incidents · unresolved error groups · write failures · feed disconnects',
    },
    {
      id: 'activity',
      href: '/data-saver/insights/activity',
      title: 'Recent Activity',
      description: 'Latest Event Ledger activity across Data Saver.',
      icon: ActivityIcon,
      accent: 'sky',
      hero: fmtCount(s.activity.count),
      heroLabel: 'EVENTS · 24H',
      heroTone: 'neutral',
      keyRows: [
        { label: 'Categories', value: String(Object.keys(s.activity.categories ?? {}).length) },
        { label: 'Last event', value: fmtAgo(s.activity.lastEventAt) },
        { label: 'Top category', value: topCategory(s.activity.categories) },
      ],
      detailRows: Object.entries(s.activity.severity ?? {}).map(([k, v]) => ({
        label: `${k} events`, value: fmtCount(v), tone: severityState(k) as UiTone,
      })),
      note: `last: ${lastEv?.event_type || lastEv?.event || '—'}`,
    },
    {
      id: 'errors',
      href: '/data-saver/insights/errors',
      title: 'Error Center',
      description: 'Recurring errors grouped by fingerprint and correlated with recovery evidence.',
      icon: AlertOctagon,
      accent: s.errors.open > 0 ? 'danger' : 'teal',
      hero: fmtCount(s.errors.open),
      heroLabel: 'OPEN GROUPS',
      heroTone: s.errors.open > 0 ? 'danger' : 'success',
      keyRows: [
        { label: 'Occurrences', value: fmtCount(s.errors.occurrences) },
        { label: 'Recovered', value: fmtCount(s.errors.resolved), tone: 'success' },
        { label: 'Last seen', value: fmtAgo(s.errors.preview?.[0]?.lastSeen) },
      ],
      detailRows: [
        { label: 'Total groups', value: fmtCount(s.errors.total) },
        { label: 'Newest group', value: fmtAgo(s.errors.preview?.[s.errors.preview.length - 1]?.lastSeen) },
      ],
      note: 'grouped by category · event_type · reason_code · component',
    },
    {
      id: 'today',
      href: '/data-saver/insights/today',
      title: 'Today in Data Saver',
      description: `${s.today.marketDate || 'Today'} — one digest of events, alerts and activity.`,
      icon: CalendarDays,
      accent: 'violet',
      hero: fmtCount(s.today.total),
      heroLabel: 'EVENTS TODAY',
      heroTone: 'neutral',
      keyRows: [
        { label: 'Alerts', value: fmtCount(s.today.alerts), tone: countTone(s.today.alerts, 1, 1) },
        { label: 'Notifications', value: fmtCount(s.today.notifications) },
        { label: 'Ticks', value: fmtCount(s.today.ticks) },
      ],
      detailRows: [
        { label: 'Critical', value: fmtCount(s.today.events?.critical_events ?? null), tone: countTone(s.today.events?.critical_events ?? null, 1, 1) },
        { label: 'Warnings', value: fmtCount(s.today.events?.warnings ?? null) },
        { label: 'Errors', value: fmtCount(s.today.events?.errors ?? null) },
        { label: 'Recoveries', value: fmtCount(s.today.events?.recoveries ?? null), tone: 'success' },
        { label: 'Incidents', value: fmtCount(s.today.incidents) },
      ],
      note: `as of ${fmtTime(gen)} IST`,
    },
  ];
}

function topCategory(cats?: Record<string, number>): string {
  const entries = Object.entries(cats ?? {});
  if (entries.length === 0) return '—';
  const [k, v] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  return `${k} · ${fmtCount(v)}`;
}

/* ========================================================================== */
/* Page                                                                        */
/* ========================================================================== */

export default function Phase2InsightsPage() {
  const [summary, setSummary] = useState<InsightsSummaryResponse | null>(null);
  const [recentEvents, setRecentEvents] = useState<LedgerEvent[]>([]);
  const [cards, setCards] = useState<CardsResponse | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [api, setApi] = useState<ApiTelemetrySummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const loadSummary = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setSummary(await getInsightsSummary());
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load Data Insights');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      setRecentEvents((await getInsightsEvents({ limit: 8 })).events);
    } catch { /* preview is non-critical */ }
  }, []);

  const loadTelemetry = useCallback(async () => {
    const [c, t, a] = await Promise.allSettled([
      getInsightsCards(24),
      getInsightsTelemetry(24, undefined, 1),
      getInsightsApiTelemetry(24),
    ]);
    if (c.status === 'fulfilled') setCards(c.value);
    if (t.status === 'fulfilled') setTelemetry(t.value.series ?? []);
    if (a.status === 'fulfilled') setApi(a.value);
  }, []);

  const refreshAll = useCallback(() => {
    void loadSummary();
    void loadRecent();
    void loadTelemetry();
    setRefreshNonce((n) => n + 1);
  }, [loadSummary, loadRecent, loadTelemetry]);

  // Single mount fetch (no double-fire).
  useEffect(() => {
    void loadSummary();
    void loadRecent();
    void loadTelemetry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Silent re-fetch on the refresh button only.
  useEffect(() => {
    if (refreshNonce === 0) return;
    void loadSummary(true);
    void loadRecent();
    void loadTelemetry();
  }, [loadSummary, loadRecent, loadTelemetry, refreshNonce]);

  // On attention-worthy frames re-fetch quietly so counts stay honest.
  const onStreamFrame = useCallback((frame: InsightStreamFrame) => {
    const t = frame.type;
    if (t === 'incident_created' || t === 'incident_resolved') {
      void loadSummary(true); void loadRecent(); void loadTelemetry();
      return;
    }
    if (t === 'insight_event' && ['error', 'critical', 'warning'].includes(String(frame.severity).toLowerCase())) {
      void loadSummary(true); void loadRecent();
    }
  }, [loadSummary, loadRecent, loadTelemetry]);

  const { connected } = useInsightsStream(onStreamFrame);

  const cardsModel = useMemo(() => (summary ? cardMeta(summary) : null), [summary]);
  const live = summary?.live;
  const lastEvent = live?.lastEvent;

  if (error && !summary) {
    return (
      <div className="space-y-3">
        <InsightHeader title="Data Insights" subtitle="Live intelligence across the Data Saver" />
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button className="ml-3 text-xs underline" onClick={refreshAll}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-16">

      <InsightHeader
        title="Data Insights"
        subtitle="Attention, activity, errors and today — every figure from the live Event Ledger, tick pipeline and system state"
        live={connected}
        tone="teal"
        actions={
          <>
            <Link
              href="/data-saver/insights/reports"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CalendarDays className="h-3.5 w-3.5" /> Reports
            </Link>
            <RefreshButton onClick={refreshAll} busy={loading} />
          </>
        }
        badges={
          live && (
            <>
              <StatusBadge status={live.market?.tradingDay ? 'success' : 'neutral'} label={String(live.market?.marketState ?? '—').replace(/_/g, ' ')} />
              <StatusBadge status={live.websocket?.connected ? 'success' : 'danger'} label={`WS ${live.websocket?.feedState ?? '—'}`} />
              <StatusBadge status={live.pipeline?.running ? 'success' : 'warning'} label={`PIPE ${live.pipeline?.running ? 'RUN' : 'STOP'}`} />
              <StatusBadge status={live.database?.connected ? 'success' : 'danger'} label={`DB ${live.database?.connected ? 'UP' : 'DOWN'}`} />
              <StatusBadge status={live.scheduler?.running ? 'success' : 'warning'} label={live.scheduler?.state ?? 'SCHEDULER —'} />
              <StatusBadge status={live.session?.active ? 'success' : 'neutral'} label={`SESSION ${live.session?.status ?? '—'}`} />
              <StatusBadge status={countTone(live.alerts?.activeAlerts ?? null)} label={`${fmtCount(live.alerts?.activeAlerts ?? null)} ALERTS`} />
              <StatusBadge status="info" label={`${fmtCount(live.notifications?.unread ?? null)} UNREAD`} />
              <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                snapshot {fmtAgo(summary?.generatedAt)}
              </span>
            </>
          )
        }
      />

      {loading && !summary ? (
        <div className="py-20 text-center text-xs text-muted-foreground">Loading real-time overview…</div>
      ) : cardsModel ? (
        <>
          {/* ── Four primary intelligence sections ── */}
          <TileGrid cols={4}>
            {cardsModel.map((c) => (
              <Link key={c.id} href={c.href} className="group block h-full">
                <Tile
                  {...c}
                  footer={
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[9px] text-muted-foreground">{c.description}</span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                    </span>
                  }
                />
              </Link>
            ))}
          </TileGrid>

          {/* ── LIVE: tick pipeline telemetry ── */}
          <LivePipelineTile telemetry={telemetry} cards={cards} loading={loading} />

          {/* ── LIVE: API telemetry ── */}
          <ApiTelemetryTile api={api} />

          {/* ── Latest ledger activity ── */}
          <SectionCard title="Latest Ledger Activity" icon={ListFilter} className="border-t-2 border-t-orange-500"
            headerRight={
              <Link href="/data-saver/insights/activity" className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
            {recentEvents.length === 0 ? (
              <p className="py-4 text-center text-[11px] text-muted-foreground">No ledger events recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border/30" data-verify="activity-preview">
                {recentEvents.slice(0, 6).map((ev) => (
                  <li key={ev.event_id || `${ev.timestamp}-${ev.message}`} className="flex items-center gap-2 py-1.5">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
                      ev.severity === 'critical' || ev.severity === 'error' ? 'bg-destructive'
                        : ev.severity === 'warning' ? 'bg-warning' : 'bg-success')} />
                    <span className="min-w-0 flex-1 truncate text-[11px]">{ev.message || ev.event_type || ev.event || '—'}</span>
                    {ev.symbol && <span className="shrink-0 rounded border border-border/60 px-1 text-[9px]">{ev.symbol}</span>}
                    <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] uppercase text-muted-foreground">{ev.category}</span>
                    <span className="shrink-0 font-mono text-[9px] text-muted-foreground">{fmtTime(ev.timestamp)} · {fmtAgo(ev.timestamp)}</span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <StatusStrip>
            <span className="flex items-center gap-1.5 text-[10px]">
              <Wifi className={cn('h-3 w-3', live?.websocket?.connected ? 'text-success' : 'text-destructive')} />
              <span className="font-medium">Last event</span>
              <span className="truncate text-foreground">
                {lastEvent?.message ? String(lastEvent.message).slice(0, 70) : lastEvent ? `${lastEvent.source || 'ledger'} · ${lastEvent.event || 'event'}` : 'No ledger events yet'}
              </span>
              <span className="font-mono text-muted-foreground">{fmtTime(lastEvent?.timestamp)} IST</span>
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Server className="h-3 w-3" /> {fmtTime(summary?.generatedAt)} IST
            </span>
          </StatusStrip>
        </>
      ) : (
        <p className="py-20 text-center text-xs text-muted-foreground">No data yet.</p>
      )}
    </div>
  );
}

/* ========================================================================== */
/* Live: tick pipeline                                                         */
/* ========================================================================== */

function LivePipelineTile({ telemetry, cards, loading }: {
  telemetry: TelemetryPoint[]; cards: CardsResponse | null; loading: boolean;
}) {
  const tel = cards?.telemetry;
  const ev = cards?.events;

  // `feedLatencyMs` arrives as a stats object on the live snapshot but a plain
  // number on cards telemetry — accept both without inventing either.
  const latencyOf = (p: TelemetryPoint): number | null => {
    const v = p.feedLatencyMs as unknown;
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const cur = (v as { currentMs?: number }).currentMs;
    return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
  };

  const series = useMemo(() => telemetry.slice(-120), [telemetry]);
  const recv = series.map((p) => (Number.isFinite(p.received) ? p.received : null));
  const tps = series.map((p) => (Number.isFinite(p.ticksPerSecond as number) ? (p.ticksPerSecond as number) : null));
  const lat = series.map(latencyOf);

  const last = series.length ? series[series.length - 1] : null;
  // Feed latency is derived ONLY from measured per-bucket samples — the
  // telemetry endpoint has no aggregate block, so nothing is invented here.
  const latSamples = useMemo(() => lat.filter((v): v is number => v != null), [lat]);
  const latAvg = latSamples.length ? latSamples.reduce((a, b) => a + b, 0) / latSamples.length : null;
  const latMax = latSamples.length ? Math.max(...latSamples) : null;
  const latMin = latSamples.length ? Math.min(...latSamples) : null;
  const lastLat = last ? latencyOf(last) : null;

  const columns: Column<TelemetryPoint>[] = [
    { key: 'time', label: 'Bucket', render: (p) => <span className="font-mono text-muted-foreground">{p.bucket || fmtTime(p.timestamp)}</span> },
    { key: 'recv', label: 'Received', align: 'right', render: (p) => val(p.received) },
    { key: 'written', label: 'Written', align: 'right', render: (p) => val(p.written) },
    { key: 'errors', label: 'Errors', align: 'right', render: (p) => <span className={countTone(p.errors, 1, 1) === 'danger' ? 'text-destructive' : 'text-foreground'}>{val(p.errors)}</span> },
    { key: 'tps', label: 't/s', align: 'right', render: (p) => val(p.ticksPerSecond) },
    { key: 'wsps', label: 'WS w/s', align: 'right', compactHide: true, render: (p) => val(p.writesPerSecond) },
    { key: 'syms', label: 'Symbols', align: 'right', compactHide: true, render: (p) => val(p.activeSymbols) },
    { key: 'buf', label: 'Buffer', align: 'right', compactHide: true, render: (p) => val(p.bufferLength) },
    { key: 'lat', label: 'Feed lat', align: 'right', render: (p) => <span title="ws_recv → backend">{latencyOf(p) == null ? '—' : `${latencyOf(p)!} ms`}</span> },
    { key: 'ws', label: 'WS', render: (p) => <StatusBadge status={p.wsConnected ? 'success' : 'danger'} label={p.wsConnected ? 'up' : 'down'} /> },
  ];

  return (
    <SectionCard title="Live Tick Pipeline" icon={Gauge} className="border-t-2 border-t-sky-500"
      headerRight={
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={tel ? (tel.tickErrors > 0 ? 'warning' : 'success') : 'neutral'} label={tel ? `${fmtCount(tel.tickErrors ?? null)} tick errors` : 'not measured'} />
          <StatusBadge status="info" label={`${series.length} buckets`} />
        </div>
      }
    >
      <TileGrid cols={4}>
        <Tile
          icon={ActivityIcon} title="Ticks Received" accent="teal"
          hero={loading ? '…' : val(tel?.ticksReceived ?? null)} heroLabel="24H WINDOW"
          keyRows={[
            { label: 'Written', value: val(tel?.ticksWritten ?? null), tone: 'success' },
            { label: 'Errors', value: val(tel?.tickErrors ?? null), tone: countTone(tel?.tickErrors ?? null, 1, 1) },
            { label: 'Write success', value: tel?.writeSuccessPct == null ? '—' : `${tel.writeSuccessPct}%`, tone: pctTone(tel?.writeSuccessPct) },
          ]}
          detailRows={[
            { label: 'Buckets', value: val(tel?.buckets ?? null) },
            { label: 'Latest t/s', value: last?.ticksPerSecond == null ? '—' : val(last.ticksPerSecond), tone: 'info' },
            { label: 'Latest recv', value: last ? val(last.received) : '—' },
          ]}
          note="db_writer_engine + telemetry buckets"
        />
        <Tile
          icon={TrendingUp} title="Events 24h" accent="violet"
          hero={loading ? '…' : val(ev?.total ?? null)} heroLabel="LEDGER EVENTS"
          keyRows={Object.entries(ev?.categories ?? {}).slice(0, 3).map(([k, v]) => ({ label: k, value: fmtCount(v) }))}
          detailRows={Object.entries(ev?.categories ?? {}).slice(3).map(([k, v]) => ({ label: k, value: fmtCount(v) }))}
          note={ev?.hasData ? 'event ledger digest' : 'no events in window'}
        />
        <Tile
          icon={Clock} title="Feed Latency" accent="amber"
          hero={loading ? '…' : (lastLat == null ? '—' : val(lastLat))}
          heroUnit={lastLat == null ? undefined : 'ms'} heroLabel="LATEST BUCKET"
          heroTone="neutral"
          keyRows={[
            { label: 'Average', value: latAvg == null ? '—' : `${val(Math.round(latAvg))} ms` },
            { label: 'Max', value: latMax == null ? '—' : `${val(latMax)} ms` },
            { label: 'Min', value: latMin == null ? '—' : `${val(latMin)} ms` },
          ]}
          detailRows={[{ label: 'Samples', value: latSamples.length ? val(latSamples.length) : '—' }]}
          note="pipeline_latency ws_recv→backend"
        />
        <Tile
          icon={AlertOctagon} title="Errors 24h" accent="danger"
          hero={loading ? '…' : val(cards?.errors?.open ?? null)} heroLabel="OPEN GROUPS"
          heroTone={countTone(cards?.errors?.open ?? null)}
          keyRows={[
            { label: 'Occurrences', value: val(cards?.errors?.occurrences ?? null) },
            { label: 'Recovered', value: val(cards?.errors?.resolved ?? null), tone: 'success' },
            { label: 'All groups', value: val(cards?.errors?.groupTotal ?? null) },
          ]}
          detailRows={[{ label: 'Incidents', value: val(cards?.incidents ?? null) }]}
          note="grouped error fingerprint"
        />
      </TileGrid>

      <div className="mt-3 space-y-2">
        <div>
          <p className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">Ticks received / min</p>
          <div className="rounded border border-border/50 bg-muted/20 px-1.5 py-1">
            <SparkBars data={recv} color="#14b8a6" height={40} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">Ticks per second</p>
            <div className="rounded border border-border/50 bg-muted/20 px-1.5 py-1">
              <SparkBars data={tps} color="#38bdf8" height={32} />
            </div>
          </div>
          <div>
            <p className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">Feed latency (ms)</p>
            <div className="rounded border border-border/50 bg-muted/20 px-1.5 py-1">
              <SparkBars data={lat} color="#f59e0b" height={32} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <SectionHeading>Telemetry Buckets</SectionHeading>
        <div className="mt-1.5">
          <DataTable
            columns={columns} rows={series} rowId={(p, i) => `${p.bucket || p.timestamp || i}`}
            maxHeight={240} verify="pipeline-telemetry"
            footer={<><span>showing {series.length} of {telemetry.length}</span><span>source: insights/telemetry</span></>}
            empty={<p className="py-4 text-center text-[11px] text-muted-foreground">No telemetry buckets in this window.</p>}
          />
        </div>
      </div>
    </SectionCard>
  );
}

/* ========================================================================== */
/* Live: API telemetry                                                         */
/* ========================================================================== */

function ApiTelemetryTile({ api }: { api: ApiTelemetrySummary | null }) {
  const endpoints = api?.endpoints ?? [];
  const top = [...endpoints].sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0)).slice(0, 8);

  const columns: Column<typeof top[number]>[] = [
    { key: 'route', label: 'Route', render: (e) => <span className="font-mono text-[9px]">{e.route || '—'}</span> },
    { key: 'req', label: 'Requests', align: 'right', render: (e) => val(e.requests) },
    { key: 'succ', label: 'Success', align: 'right', render: (e) => <span className={e.successPct == null ? '' : pctTone(e.successPct, 99, 95) === 'success' ? 'text-emerald-500' : e.successPct >= 95 ? 'text-amber-500' : 'text-destructive'}>{e.successPct == null ? '—' : `${e.successPct}%`}</span> },
    { key: 'avg', label: 'Avg', align: 'right', render: (e) => (e.avgMs == null ? '—' : `${val(e.avgMs)} ms`) },
    { key: 'err', label: 'Errors', align: 'right', render: (e) => <span className={countTone(e.errors, 1, 1) === 'danger' ? 'text-destructive' : 'text-foreground'}>{val(e.errors)}</span> },
    { key: 'c4', label: '4xx', align: 'right', compactHide: true, render: (e) => val(e.clientErrors) },
    { key: 'c5', label: '5xx', align: 'right', compactHide: true, render: (e) => <span className={countTone(e.serverErrors, 1, 1) === 'danger' ? 'text-destructive' : 'text-foreground'}>{val(e.serverErrors)}</span> },
  ];

  return (
    <SectionCard title="Live API Telemetry" icon={Server} className="border-t-2 border-t-indigo-500"
      headerRight={
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={api?.hasData ? (api.serverErrors > 0 ? 'warning' : 'success') : 'neutral'} label={api?.hasData ? 'measured' : 'not measured'} />
          {api && <StatusBadge status="info" label={`${endpoints.length} endpoints`} />}
        </div>
      }
    >
      <TileGrid cols={4}>
        <Tile
          icon={Server} title="Requests" accent="sky"
          hero={val(api?.requests ?? null)} heroLabel="24H TOTAL"
          keyRows={[
            { label: 'Success', value: val(api?.success ?? null), tone: 'success' },
            { label: 'Success %', value: api?.successPct == null ? '—' : `${api.successPct}%`, tone: pctTone(api?.successPct, 99, 95) },
            { label: 'Error %', value: api?.errorPct == null ? '—' : `${api.errorPct}%`, tone: countTone(api?.errorPct, 1, 1) },
          ]}
          detailRows={[
            { label: 'Client 4xx', value: val(api?.clientErrors ?? null) },
            { label: 'Server 5xx', value: val(api?.serverErrors ?? null), tone: countTone(api?.serverErrors ?? null, 1, 1) },
            { label: 'DB failures', value: val(api?.dbRelatedFailures ?? null), tone: countTone(api?.dbRelatedFailures ?? null, 1, 1) },
          ]}
          note="fastapi request buckets"
        />
        <Tile
          icon={Clock} title="API Latency" accent="violet"
          hero={api?.avgLatencyMs == null ? '—' : val(api.avgLatencyMs)} heroUnit={api?.avgLatencyMs == null ? undefined : 'ms'} heroLabel="AVERAGE"
          keyRows={[
            { label: 'p50', value: api?.p50Ms == null ? '—' : `${val(api.p50Ms)} ms` },
            { label: 'p95', value: api?.p95Ms == null ? '—' : `${val(api.p95Ms)} ms` },
            { label: 'p99', value: api?.p99Ms == null ? '—' : `${val(api.p99Ms)} ms` },
          ]}
          note="request duration percentiles"
        />
        <Tile
          icon={Database} title="Data Saver Health" accent="teal"
          hero={summaryHealth(api)} heroLabel="COMPONENTS UP"
          heroTone={healthSummaryTone(api)}
          keyRows={[
            { label: 'Errors', value: val(api?.errors ?? null), tone: countTone(api?.errors ?? null, 1, 1) },
            { label: 'Endpoints', value: val(endpoints.length || null) },
            { label: 'Window', value: '24h' },
          ]}
          note="derived from measured error + latency state"
        />
        <Tile
          icon={CheckCircle2} title="Coverage" accent="slate"
          hero={endpoints.length ? val(endpoints.length) : '—'} heroLabel="ENDPOINTS SEEN"
          keyRows={[
            { label: 'With errors', value: val(endpoints.filter((e) => (e.errors ?? 0) > 0).length || null) },
            { label: '5xx routes', value: val(endpoints.filter((e) => (e.serverErrors ?? 0) > 0).length || null), tone: countTone(endpoints.filter((e) => (e.serverErrors ?? 0) > 0).length || null, 1, 1) },
            { label: 'Avg of routes', value: endpoints.length ? `${val(Math.round(endpoints.reduce((s, e) => s + (e.avgMs ?? 0), 0) / endpoints.length))} ms` : '—' },
          ]}
          note="route-level rollup of api-telemetry"
        />
      </TileGrid>

      <div className="mt-3">
        <SectionHeading>Top Endpoints</SectionHeading>
        <div className="mt-1.5">
          <DataTable
            columns={columns} rows={top} rowId={(e, i) => `${e.route || i}`} maxHeight={220}
            verify="api-endpoints"
            footer={<><span>showing {top.length} of {endpoints.length}</span><span>source: insights/api-telemetry</span></>}
            empty={<p className="py-4 text-center text-[11px] text-muted-foreground">No API telemetry recorded in this window.</p>}
          />
        </div>
      </div>
    </SectionCard>
  );
}

/** Honest component rollup: each flag must be measured, never assumed true. */
function summaryHealth(api: ApiTelemetrySummary | null): string {
  if (!api?.hasData) return '—';
  const db = !api.dbRelatedFailures;
  const apiOk = api.serverErrors === 0;
  return `${[db, apiOk].filter(Boolean).length}/2`;
}

function healthSummaryTone(api: ApiTelemetrySummary | null): UiTone {
  if (!api?.hasData) return 'neutral';
  return api.dbRelatedFailures === 0 && api.serverErrors === 0 ? 'success' : 'warning';
}