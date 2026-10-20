'use client';

// Data Quality — real-time market-data pipeline monitoring console.
//
// Read-only observer of the live pipeline:
//   Kotak Neo -> WebSocket Engine -> Market Watch -> Live Tick
//     -> DB Writer (SAVE/DROP) -> MongoDB
//
// Data flow: ONE snapshot (GET /api/data-quality/live) + aggregated
// `quality_live` frames every ~1s over the existing shared SSE stream.
// No REST polling, no per-tick traffic, no stock-specific ticker, no mock
// data. Unavailable => "Waiting for live data" / "--" — never fabricated.

import { memo, useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  Copy,
  Database,
  Gauge,
  Radio,
  RefreshCw,
  Save,
  Satellite,
  Server,
  Timer,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PageHeader,
  MetricCard,
  SectionCard,
  StatusBadge,
  EmptyState,
  ErrorState,
} from '@/components/design-system';
import { cn } from '@/lib/utils';
import { useDataQualityLive } from '@/hooks/use-data-quality-live';

/* ---------------- formatting (presentation only) ---------------- */

function fmtInt(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v).toLocaleString('en-IN');
}

function fmtRate(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 100) return Math.round(v).toLocaleString('en-IN');
  return v.toFixed(v >= 10 ? 1 : 2);
}

function fmtPct(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  return `${v.toFixed(v >= 10 ? 2 : 3)}%`;
}

function fmtMs(v: number | null | undefined): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  return `${Math.round(v)} ms`;
}

function fmtUptime(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const istTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function fmtTimeIST(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${istTimeFmt.format(d)} IST`;
  } catch {
    return null;
  }
}

function missing(v: unknown): boolean {
  return v == null || (typeof v === 'number' && !Number.isFinite(v));
}

/* ---------------- small pieces ---------------- */

function ConnDot({ ok }: { ok: boolean | null | undefined }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        ok === true && 'bg-success',
        ok === false && 'bg-destructive',
        ok == null && 'bg-muted-foreground/40',
      )}
    />
  );
}

const TopPill = memo(function TopPill({
  label,
  ok,
  state,
  detail,
  loading,
}: {
  label: string;
  ok: boolean | null | undefined;
  state?: string | null;
  detail?: string | null;
  loading?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
      <ConnDot ok={ok} />
      <span className="truncate text-xs font-medium">{label}</span>
      {loading ? (
        <span className="text-[11px] text-muted-foreground">…</span>
      ) : (
        <span
          className={cn(
            'text-[11px] font-semibold tabular-nums',
            ok === true && 'text-success',
            ok === false && 'text-destructive',
            ok == null && 'text-muted-foreground',
          )}
        >
          {state ?? (ok === true ? 'Connected' : ok === false ? 'Disconnected' : '--')}
        </span>
      )}
      {detail ? (
        <span className="hidden truncate text-[11px] text-muted-foreground tabular-nums sm:inline">
          {detail}
        </span>
      ) : null}
    </div>
  );
});

const PipelineStage = memo(function PipelineStage({
  name,
  ok,
  state,
  meta,
  isLast,
}: {
  name: string;
  ok: boolean | null | undefined;
  state?: string | null;
  meta?: string | null;
  isLast?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-stretch">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
        <ConnDot ok={ok} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{name}</p>
          <p
            className={cn(
              'truncate text-[11px] tabular-nums',
              ok === true && 'text-success',
              ok === false && 'text-destructive',
              ok == null && 'text-muted-foreground',
            )}
          >
            {state ?? (ok == null ? 'Waiting for data' : ok ? 'Running' : 'Stopped')}
          </p>
        </div>
        {meta ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{meta}</span>
        ) : null}
      </div>
      {!isLast && (
        <div aria-hidden className="flex items-center justify-center py-1 text-muted-foreground/50">
          <ArrowDown className="h-4 w-4" />
        </div>
      )}
    </div>
  );
});

function Kv({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-[11px] text-muted-foreground">{k}</span>
      <span className="truncate text-xs font-semibold tabular-nums">{v ?? '--'}</span>
    </div>
  );
}

function sevTone(sev: string | undefined): 'danger' | 'warning' | 'info' | 'neutral' {
  const s = (sev ?? '').toLowerCase();
  if (s === 'critical' || s === 'error') return 'danger';
  if (s === 'warning') return 'warning';
  return 'info';
}

/* ---------------- memoized sections (selective rendering) ---------------- */

const OverviewGrid = memo(function OverviewGrid({
  cards,
  stale,
}: {
  cards: Array<{
    key: string;
    icon: React.ElementType;
    tone: 'blue' | 'success' | 'teal' | 'danger' | 'orange' | 'warning' | 'purple' | 'cyan';
    title: string;
    value: string | null;
    sub?: React.ReactNode;
    unavailable?: boolean;
  }>;
  stale: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <MetricCard
          key={c.key}
          icon={c.icon}
          tone={c.tone}
          title={c.title}
          value={c.value}
          sub={c.sub}
          stale={stale}
          unavailable={c.unavailable}
          dataVerify={`dq-${c.key}`}
        />
      ))}
    </div>
  );
});

const ThroughputSection = memo(function ThroughputSection({
  ingress,
  processing,
  write,
  drop,
  fail,
}: {
  ingress: string | null;
  processing: string | null;
  write: string | null;
  drop: string | null;
  fail: string | null;
}) {
  const rows: Array<[string, string | null]> = [
    ['Ingress', ingress != null ? `${ingress}/s` : null],
    ['Processing', processing != null ? `${processing}/s` : null],
    ['DB Write', write != null ? `${write}/s` : null],
    ['Dropped', drop != null ? `${drop}/s` : null],
    ['Failed', fail != null ? `${fail}/s` : null],
  ];
  return (
    <SectionCard title="Throughput" icon={Gauge} headerRight={<span className="text-[11px] text-muted-foreground">backend rates</span>}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 sm:grid-cols-3 lg:grid-cols-5">
        {rows.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border/50 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{k}</p>
            <p className="truncate text-lg font-semibold tabular-nums">{v ?? '--'}</p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
});

const IngestionSection = memo(function IngestionSection({
  conn,
  ping,
  received,
  queued,
  written,
  failed,
  dropped,
  writeRate,
  queue,
  writeLatency,
  batchSize,
  flushInterval,
  lastWrite,
  lastError,
  uptime,
}: {
  conn: string | null;
  ping: string | null;
  received: string | null;
  queued: string | null;
  written: string | null;
  failed: string | null;
  dropped: string | null;
  writeRate: string | null;
  queue: string | null;
  writeLatency: string | null;
  batchSize: string | null;
  flushInterval: string | null;
  lastWrite: string | null;
  lastError: string | null;
  uptime: string | null;
}) {
  return (
    <SectionCard
      title="MongoDB Ingestion"
      icon={Database}
      headerRight={<span className="text-[11px] text-muted-foreground tabular-nums">{conn ?? ''}{ping ? ` · ${ping}` : ''}</span>}
    >
      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        <div className="divide-y divide-border/40">
          <Kv k="Received" v={received} />
          <Kv k="Queued" v={queued} />
          <Kv k="Written" v={written} />
          <Kv k="Failed" v={failed} />
          <Kv k="Dropped" v={dropped} />
        </div>
        <div className="divide-y divide-border/40">
          <Kv k="Write Rate" v={writeRate} />
          <Kv k="Queue Depth" v={queue} />
          <Kv k="Write Latency" v={writeLatency} />
          <Kv k="Batch Size" v={batchSize} />
          <Kv k="Flush Interval" v={flushInterval} />
        </div>
        <div className="divide-y divide-border/40 col-span-2 sm:col-span-1">
          <Kv k="Last Write" v={lastWrite} />
          <Kv k="Last Error" v={lastError} />
          <Kv k="Writer Uptime" v={uptime} />
        </div>
      </div>
    </SectionCard>
  );
});

const FreshnessSection = memo(function FreshnessSection({
  lastTick,
  tickAge,
  lastWrite,
  writeAge,
  state,
}: {
  lastTick: string | null;
  tickAge: string | null;
  lastWrite: string | null;
  writeAge: string | null;
  state: string | null;
}) {
  const tone = state === 'LIVE' ? 'success' : state === 'DEGRADED' || state === 'STALE' ? 'warning' : 'neutral';
  return (
    <SectionCard
      title="Data Freshness"
      icon={Timer}
      headerRight={state ? <StatusBadge status={tone} label={state} /> : null}
    >
      <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-4">
        <Kv k="Last Tick" v={lastTick} />
        <Kv k="Tick Age" v={tickAge} />
        <Kv k="Last DB Write" v={lastWrite} />
        <Kv k="Write Age" v={writeAge} />
      </div>
    </SectionCard>
  );
});

const SystemSection = memo(function SystemSection({
  rows,
}: {
  rows: Array<{ name: string; ok: boolean | null | undefined; state: string | null; detail: string | null }>;
}) {
  return (
    <SectionCard title="System / Engine Status" icon={Server}>
      <ul className="divide-y divide-border/40">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-2 py-1.5">
            <ConnDot ok={r.ok} />
            <span className="w-28 shrink-0 truncate text-xs font-medium">{r.name}</span>
            <span
              className={cn(
                'shrink-0 text-[11px] font-semibold tabular-nums',
                r.ok === true && 'text-success',
                r.ok === false && 'text-destructive',
                r.ok == null && 'text-muted-foreground',
              )}
            >
              {r.state ?? '--'}
            </span>
            {r.detail ? (
              <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground tabular-nums">
                {r.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
});

/* ---------------- page ---------------- */

export default function DataQualityPage() {
  const { data, sseConnected, live, stale, lastUpdateAt, error, retry } =
    useDataQualityLive(true);

  const loading = data == null && !error;
  const hasData = data != null;

  const freshness = useMemo(() => (data?.freshnessState ?? '').toUpperCase() || null, [data]);
  const writeState = useMemo(() => (data?.writeAgeState ?? '').toUpperCase() || null, [data]);

  const streamBadge = useMemo(() => {
    if (error && !hasData) return <StatusBadge status="danger" label="Backend unavailable" />;
    if (stale) return <StatusBadge status="warning" label="STALE" />;
    if (live) return <StatusBadge status="success" label="LIVE" />;
    if (!sseConnected) return <StatusBadge status="warning" label="Reconnecting…" />;
    if (freshness === 'NO_DATA') return <StatusBadge status="neutral" label="Waiting for data" />;
    return <StatusBadge status="neutral" label="Connecting…" />;
  }, [error, hasData, stale, live, sseConnected, freshness]);

  const ws = data?.websocket;
  const mw = data?.marketWatch;
  const dbw = data?.dbWriter;
  const mongo = data?.mongodb;
  const tp = data?.throughput;
  const ing = data?.ingestion;
  const sched = data?.scheduler;
  const sess = data?.session;

  const wsOk = hasData ? (ws?.connected ?? null) : null;
  const mwOk = hasData ? (mw?.running ?? null) : null;
  const dbOk = hasData ? (dbw?.running ?? null) : null;
  const mongoOk = hasData ? (mongo?.connected ?? null) : null;
  const schedOk = hasData ? (sched?.running ?? null) : null;
  const sessOk = hasData ? (sess?.active ?? null) : null;

  const cards = useMemo(
    () => [
      { key: 'total', icon: Activity, tone: 'blue' as const, title: 'Total Ticks',
        value: hasData ? (fmtInt(data?.totalTicks) ?? '--') : null, sub: hasData ? 'received · live pipeline' : undefined,
        unavailable: hasData && missing(data?.totalTicks) },
      { key: 'rate', icon: Radio, tone: 'success' as const, title: 'Tick Rate',
        value: hasData ? (data?.tickRate != null ? `${fmtRate(data?.tickRate)} /s` : '--') : null,
        sub: hasData ? (freshness ?? '') : undefined, unavailable: false },
      { key: 'saved', icon: Save, tone: 'teal' as const, title: 'Saved',
        value: hasData ? (fmtInt(data?.savedTicks) ?? '--') : null, sub: hasData ? (fmtPct(data?.savedPct) ?? '--') : undefined,
        unavailable: hasData && missing(data?.savedTicks) },
      { key: 'failed', icon: XCircle, tone: 'danger' as const, title: 'Failed',
        value: hasData ? (fmtInt(data?.failedTicks) ?? '--') : null, sub: hasData ? (fmtPct(data?.failedPct) ?? '--') : undefined,
        unavailable: hasData && missing(data?.failedTicks) },
      { key: 'dup', icon: Copy, tone: 'orange' as const, title: 'Duplicates',
        value: hasData ? (fmtInt(data?.duplicateTicks) ?? '--') : null, sub: hasData ? (fmtPct(data?.duplicatePct) ?? '--') : undefined,
        unavailable: hasData && missing(data?.duplicateTicks) },
      { key: 'dropped', icon: AlertTriangle, tone: 'warning' as const, title: 'Dropped',
        value: hasData ? (fmtInt(data?.droppedTicks) ?? '--') : null, sub: hasData ? (fmtPct(data?.droppedPct) ?? '--') : undefined,
        unavailable: hasData && missing(data?.droppedTicks) },
      { key: 'symbols', icon: Satellite, tone: 'purple' as const, title: 'Active Symbols',
        value: hasData ? (fmtInt(data?.activeSymbols) ?? '--') : null,
        sub: hasData && data?.tickingSymbols != null ? `${fmtInt(data?.tickingSymbols)} ticking` : undefined,
        unavailable: hasData && missing(data?.activeSymbols) },
      { key: 'fresh', icon: Timer, tone: 'cyan' as const, title: 'Data Freshness',
        value: hasData ? (fmtMs(data?.freshnessMs) ?? '--') : null, sub: hasData ? (freshness ?? '') : undefined,
        unavailable: hasData && missing(data?.freshnessMs) && freshness !== 'NO_DATA' },
    ],
    [data, hasData, freshness],
  );

  const stages = useMemo(() => {
    const find = (n: string) => (data?.pipeline ?? []).find((s) => s.name === n);
    return [
      { name: 'Market Watch', ok: mwOk, state: find('Market Watch')?.state ?? null,
        meta: hasData && mw?.subscribed != null ? `${mw.subscribed as number} syms` : null },
      { name: 'WebSocket', ok: wsOk, state: find('WebSocket')?.state ?? null,
        meta: hasData ? (`${ws?.subscriptions ?? 0} subs`) : null },
      { name: 'Tick Processing', ok: hasData ? (find('Tick Processing')?.ok ?? null) : null,
        state: find('Tick Processing')?.state ?? null,
        meta: hasData && data?.tickRate != null ? `${fmtRate(data?.tickRate)}/s` : null },
      { name: 'DB Writer', ok: dbOk, state: find('DB Writer')?.state ?? null,
        meta: hasData && dbw?.writeRate != null ? `${fmtRate(dbw.writeRate as number)}/s` : null },
      { name: 'MongoDB', ok: mongoOk, state: find('MongoDB')?.state ?? null,
        meta: hasData && mongo?.pingMs != null ? `${Math.round(Number(mongo.pingMs as number))} ms` : null },
    ];
  }, [data, hasData, mwOk, wsOk, dbOk, mongoOk, ws, mw, dbw, mongo]);

  const sysRows = useMemo(
    () => [
      { name: 'WebSocket', ok: wsOk, state: ws?.state as string ?? null,
        detail: hasData ? (`${ws?.subscriptions ?? 0} subs · ${ws?.reconnectCount ?? 0} reconnects`) : null },
      { name: 'Market Watch', ok: mwOk, state: mw?.state as string ?? null,
        detail: hasData && mw?.subscribed != null ? `${mw.subscribed as number} subscribed` : null },
      { name: 'DB Writer', ok: dbOk, state: dbw?.state as string ?? null,
        detail: hasData ? (`queue ${ing?.queueDepth ?? '--'}`) : null },
      { name: 'MongoDB', ok: mongoOk, state: mongo?.state as string ?? null,
        detail: hasData && mongo?.pingMs != null ? `${Math.round(Number(mongo.pingMs as number))} ms` : null },
      { name: 'Scheduler', ok: schedOk, state: sched?.state as string ?? null, detail: null },
      { name: 'Session', ok: sessOk, state: sess?.state as string ?? null, detail: null },
    ],
    [wsOk, mwOk, dbOk, mongoOk, schedOk, sessOk, ws, mw, dbw, mongo, sched, sess, hasData, ing],
  );

  return (
    <div className="space-y-4 pb-8">
      <PageHeader title="Data Quality" subtitle="Real-time market data pipeline monitoring">
        {streamBadge}
        {stale && hasData && (
          <Badge variant="outline" className="gap-1 text-[11px]">
            <WifiOff className="h-3 w-3" /> Reconnecting…
          </Badge>
        )}
      </PageHeader>

      {error && !hasData ? (
        <ErrorState message={error} onRetry={retry} />
      ) : (
        <>
          {/* Top connection status — real backend states only */}
          <div className="flex flex-wrap items-center gap-2">
            <TopPill label="WebSocket" ok={wsOk} state={ws?.state as string} loading={loading}
              detail={hasData ? (`${ws?.subscriptions ?? 0} subs`) : null} />
            <TopPill label="Market Watch" ok={mwOk} state={mw?.state as string} loading={loading}
              detail={hasData && mw?.subscribed != null ? (`${mw.subscribed as number} syms`) : null} />
            <TopPill label="DB Writer" ok={dbOk} state={dbw?.state as string} loading={loading}
              detail={hasData && dbw?.writeRate != null ? (`${fmtRate(dbw.writeRate as number)}/s`) : null} />
            <TopPill label="MongoDB" ok={mongoOk} state={mongo?.state as string} loading={loading}
              detail={hasData && mongo?.pingMs != null ? (`${Math.round(Number(mongo.pingMs as number))} ms`) : null} />
            <TopPill label="Scheduler" ok={schedOk} state={sched?.state as string} loading={loading} />
            <TopPill label="Session" ok={sessOk} state={sess?.state as string} loading={loading} />
          </div>

          {!hasData && loading ? (
            <OverviewGrid
              stale={false}
              cards={cards.map((c) => ({ ...c, value: null, sub: undefined, unavailable: false }))}
            />
          ) : !hasData ? (
            <SectionCard>
              <EmptyState
                icon={Wifi}
                title="Waiting for live data"
                description="Backend is reachable but no pipeline metrics have arrived yet."
              />
            </SectionCard>
          ) : (
            <>
              <OverviewGrid cards={cards} stale={stale} />

              {/* Live pipeline health */}
              <SectionCard
                title="Live Pipeline Health"
                headerRight={
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {fmtTimeIST(data?.lastTickAt) ? `Last tick ${fmtTimeIST(data?.lastTickAt)}` : 'No ticks yet'}
                  </span>
                }
              >
                <div className="flex flex-col">
                  {stages.map((s, i) => (
                    <PipelineStage key={s.name} name={s.name} ok={s.ok} state={s.state} meta={s.meta} isLast={i === stages.length - 1} />
                  ))}
                </div>
              </SectionCard>

              <ThroughputSection
                ingress={fmtRate(tp?.ingressPerSec)}
                processing={fmtRate(tp?.processingPerSec)}
                write={fmtRate(tp?.writePerSec)}
                drop={fmtRate(tp?.dropPerSec)}
                fail={fmtRate(tp?.failPerSec)}
              />

              <IngestionSection
                conn={mongo?.state as string}
                ping={mongo?.pingMs != null ? `${Math.round(Number(mongo.pingMs as number))} ms` : null}
                received={fmtInt(ing?.received)}
                queued={fmtInt(ing?.queued)}
                written={fmtInt(ing?.written)}
                failed={fmtInt(ing?.failed)}
                dropped={fmtInt(ing?.dropped)}
                writeRate={ing?.writeRate != null ? `${fmtRate(ing.writeRate)}/s` : null}
                queue={ing?.queueCapacity != null ? `${fmtInt(ing.queueDepth) ?? '--'} / ${fmtInt(ing.queueCapacity)}` : (fmtInt(ing?.queueDepth) ?? '--')}
                writeLatency={fmtMs(ing?.writeLatencyMs)}
                batchSize={ing?.batchSize != null ? fmtInt(ing.batchSize) : null}
                flushInterval={ing?.flushIntervalMs != null ? fmtMs(ing.flushIntervalMs) : null}
                lastWrite={fmtTimeIST(ing?.lastWriteAt ?? data?.lastWriteAt)}
                lastError={ing?.lastWriteError ? String(ing.lastWriteError).slice(0, 120) : null}
                uptime={fmtUptime(ing?.uptimeSec)}
              />

              <FreshnessSection
                lastTick={fmtTimeIST(data?.lastTickAt)}
                tickAge={fmtMs(data?.freshnessMs)}
                lastWrite={fmtTimeIST(data?.lastWriteAt)}
                writeAge={fmtMs(data?.writeAgeMs)}
                state={freshness === 'NO_DATA' && writeState !== 'NO_DATA' ? writeState : freshness}
              />

              {/* Recent issues — small window only */}
              <SectionCard
                title="Recent Issues"
                headerRight={
                  <span className="text-[11px] text-muted-foreground">
                    {(data?.recentIssues ?? []).length > 0 ? `${data?.recentIssues?.length} recent` : 'none recent'}
                  </span>
                }
              >
                {(data?.recentIssues ?? []).length === 0 ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    No recent issues — pipeline healthy.
                  </div>
                ) : (
                  <ul className="divide-y divide-border/50">
                    {(data?.recentIssues ?? []).slice(0, 8).map((iss, i) => (
                      <li key={`${iss.ts ?? 'no-ts'}-${iss.title}-${i}`} className="flex items-start gap-2 py-2">
                        <StatusBadge status={sevTone(iss.severity)} label={(iss.severity ?? 'info').toUpperCase()} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">{iss.title}</p>
                          {iss.detail ? <p className="truncate text-[11px] text-muted-foreground">{iss.detail}</p> : null}
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {fmtTimeIST(iss.ts) ?? '--'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              <SystemSection rows={sysRows} />

              {/* Footer */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                <span>
                  Last update {lastUpdateAt ? fmtTimeIST(new Date(lastUpdateAt).toISOString()) : '--'}
                  {data?.latencyMs != null ? ` · latency ${fmtMs(data.latencyMs)}` : ''}
                </span>
                <span className="flex items-center gap-2">
                  {sseConnected ? (
                    <span className="inline-flex items-center gap-1"><Wifi className="h-3 w-3 text-success" /> stream</span>
                  ) : (
                    <span className="inline-flex items-center gap-1"><WifiOff className="h-3 w-3 text-warning" /> reconnecting</span>
                  )}
                  {error && (
                    <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={retry}>
                      <RefreshCw className="h-3 w-3" /> Retry
                    </Button>
                  )}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
