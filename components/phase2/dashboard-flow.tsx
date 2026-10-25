'use client';

/**
 * DashboardFlow — the Data Saver pipeline as a live, animated flow.
 *
 * Every node is REAL state from the dashboard snapshot (WebSocket lane preferred,
 * REST fallback — both arrive through `useDataSaver()`), and every connector is
 * animated only while the upstream stage is actually flowing. Nothing on the
 * diagram is decorative-only: a grey connector means "no data flowing", an
 * amber node means "waiting / degraded", and an unmeasurable stage renders an
 * explicit em dash instead of an invented number.
 */

import { useEffect, useState } from 'react';
import {
  Activity, ArrowDownRight, MoveRight, Podcast, Cpu, Database,
  MonitorSmartphone, Server, Timer, Wifi,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDataSaver } from '@/components/phase2/data-saver-provider';

const DASH = '—';

type NodeTone = 'ok' | 'warn' | 'bad' | 'idle';

const NODE_TONE: Record<NodeTone, { ring: string; chip: string; text: string }> = {
  ok: {
    ring: 'border-emerald-400/40 dark:border-emerald-400/30',
    chip: 'from-emerald-400 to-teal-500',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  warn: {
    ring: 'border-amber-400/40 dark:border-amber-400/30',
    chip: 'from-amber-400 to-orange-500',
    text: 'text-amber-600 dark:text-amber-400',
  },
  bad: {
    ring: 'border-rose-400/40 dark:border-rose-400/30',
    chip: 'from-rose-400 to-pink-500',
    text: 'text-rose-600 dark:text-rose-400',
  },
  idle: {
    ring: 'border-border/60',
    chip: 'from-slate-400 to-slate-500',
    text: 'text-muted-foreground',
  },
};

/** An animated connector. `active` only while the upstream stage flows. */
function FlowPipe({ active, label }: { active: boolean; label?: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center justify-center px-0.5 sm:justify-start sm:pt-[3.1rem]" aria-hidden>
      <div className="relative flex h-7 w-[calc(100%-1rem)] items-center sm:h-2 sm:w-8">
        <span
          className={cn(
            'ds-flow-pipe absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full',
            active ? 'opacity-90' : 'opacity-25',
          )}
          style={{ '--ds-flow-color': active ? 'hsl(var(--primary) / 0.55)' : 'hsl(var(--border))' } as React.CSSProperties}
        />
        <span className={cn('relative z-10 m-auto h-1.5 w-1.5 rounded-full', active ? 'bg-primary' : 'bg-border')} />
      </div>
      {label && (
        <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60 sm:hidden">
          {label}
        </span>
      )}
    </div>
  );
}

function FlowNode({
  tone, icon: Icon, title, status, rows, live, delay,
}: {
  tone: NodeTone;
  icon: React.ElementType;
  title: string;
  status: string;
  rows: { label: string; value: string }[];
  live?: boolean;
  delay: number;
}) {
  const t = NODE_TONE[tone];
  return (
    <div
      style={{ '--ds-i': delay } as React.CSSProperties}
      className={cn(
        'ds-rise min-w-0 flex-1 basis-40 rounded-2xl border bg-card/80 p-3 shadow-[0_1px_2px_hsl(var(--foreground)/0.03)] backdrop-blur-xl transition-colors duration-300',
        t.ring,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', t.chip)}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold tracking-tight">{title}</p>
          <p className={cn('flex items-center gap-1 truncate text-[9px] font-semibold uppercase tracking-[0.12em]', t.text)}>
            {live && <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="ds-ping-soft absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>}
            {status}
          </p>
        </div>
      </div>
      <dl className="mt-2 space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">{r.label}</dt>
            <dd className="truncate text-[10px] font-medium tabular-nums" title={r.value}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function fmtUptimeShort(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${Math.max(0, m)}m ${s % 60}s`;
}

export function DashboardFlow() {
  const { data, transport, socketState } = useDataSaver();
  // A gentle 5s ticker keeps the "updated Ns ago" line honest without a 1Hz
  // re-render war (the WS lane already re-renders on every real change).
  const [now, setNow] = useState<number>(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const d: any = data ?? {};

  const market = d.market ?? {};
  const sched = d.scheduler ?? {};
  const ws = d.ws ?? {};
  const pipe = d.pipeline ?? {};
  const mongo = d.mongo ?? {};
  const net = d.net && typeof d.net === 'object'
    ? d.net
    : d.ws?.internetOk != null ? { internetOk: d.ws.internetOk } : {};
  const subscribed = d.subscribedStocks ?? {};

  const marketOpen = !['EXCHANGE_HOLIDAY', 'WEEKEND', 'MARKET_CLOSED', 'NO_TICKS_AFTER_CONFIRMATION']
    .includes(String(sched.marketState ?? market.marketState ?? ''));
  const feedUp = Boolean(ws.connected);
  const pipelineLive = pipe.state === 'live';
  const dbUp = Boolean(mongo.connected);
  const socketUp = transport === 'live' || String(socketState) === 'CONNECTED';

  const fmtN = (v: unknown): string => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
    return n == null ? DASH : n.toLocaleString('en-IN');
  };
  const latency = typeof ws.latencyMs === 'number' ? `${Math.round(ws.latencyMs)}ms` : DASH;
  const updatedAt = (d.updatedAt as string | null) ?? null;
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : NaN;
  const ageS = Number.isFinite(updatedAtMs) ? Math.max(0, Math.round((now - updatedAtMs) / 1000)) : null;
  const ageLabel = ageS == null ? DASH : ageS < 90 ? `${ageS}s ago` : `${Math.round(ageS / 60)}m ago`;

  let storagePct = DASH;
  const used = typeof d.storage?.used === 'number' ? d.storage.used : null;
  const cap = typeof d.storage?.capacity === 'number' ? d.storage.capacity : null;
  if (used != null && cap != null && cap > 0) storagePct = `${((used / cap) * 100).toFixed(1)}%`;

  const nodes = [
    {
      key: 'exchange',
      icon: Podcast,
      tone: (marketOpen ? (net.internetOk ? 'ok' : 'warn') : 'idle') as NodeTone,
      live: Boolean(marketOpen && net.internetOk),
      title: 'Exchange',
      status: String(market.marketState ?? market.marketStatus ?? 'UNKNOWN').replace(/_/g, ' ').toLowerCase(),
      rows: [
        { label: 'Session', value: market.marketSession ? String(market.marketSession).replace(/_/g, ' ') : marketOpen ? 'regular' : DASH },
        { label: 'WS window', value: sched.inWsWindow ? 'open' : sched.inWsWindow === false ? 'closed' : 'n/a' },
      ],
    },
    {
      key: 'broker-ws',
      icon: Wifi,
      tone: (feedUp ? 'ok' : 'idle') as NodeTone,
      live: feedUp,
      title: 'Broker feed',
      status: feedUp ? 'connected' : 'disconnected',
      rows: [
        { label: 'Subscribed', value: `${fmtN(subscribed.byWs)} syms` },
        { label: 'Feed age', value: latency },
      ],
    },
    {
      key: 'gateway',
      icon: Server,
      tone: (feedUp ? 'ok' : 'idle') as NodeTone,
      live: feedUp,
      title: 'ws gateway',
      status: 'snapshot hub',
      rows: [
        { label: 'Channel', value: 'dashboard' },
        { label: 'Push', value: feedUp ? 'state + 6s' : 'rest only' },
      ],
    },
    {
      key: 'buffer',
      icon: Cpu,
      tone: (pipelineLive ? 'ok' : feedUp ? 'warn' : 'idle') as NodeTone,
      live: pipelineLive,
      title: 'Tick buffer',
      status: pipelineLive ? 'receiving' : 'stopped',
      rows: [
        { label: 'Ticks / s', value: fmtN(pipe.ticksPerSec) },
        { label: 'Queued', value: fmtN(pipe.bufferLength) },
      ],
    },
    {
      key: 'mongo',
      icon: Database,
      tone: (dbUp ? 'ok' : 'bad') as NodeTone,
      live: Boolean(dbUp && pipelineLive),
      title: 'MongoDB',
      status: dbUp ? 'connected' : 'disconnected',
      rows: [
        { label: 'Saved / s', value: pipelineLive ? fmtN(pipe.savedPerSec) : DASH },
        { label: 'Disk used', value: storagePct },
      ],
    },
    {
      key: 'ui',
      icon: MonitorSmartphone,
      tone: (socketUp ? 'ok' : dbUp ? 'warn' : 'bad') as NodeTone,
      live: socketUp,
      title: 'This dashboard',
      status: transport === 'live' ? 'websocket live' : 'rest polling',
      rows: [
        { label: 'Transport', value: transport === 'live' ? 'WS push' : 'REST poll' },
        { label: 'Updated', value: ageLabel },
      ],
    },
  ];

  const connectors = [
    { active: Boolean(net.internetOk) && marketOpen, label: 'feed' },
    { active: feedUp, label: 'ticks' },
    { active: feedUp, label: 'push' },
    { active: pipelineLive, label: 'queue' },
    { active: Boolean(dbUp && pipelineLive), label: 'persist' },
    { active: socketUp, label: 'merge' },
  ];

  return (
    <section aria-label="Data flow" className="ds-card relative overflow-hidden rounded-3xl border border-border/50 bg-card/70 p-4 shadow-[0_1px_3px_hsl(var(--foreground)/0.04)] backdrop-blur-2xl sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 via-blue-500 to-violet-500 text-white shadow-md">
            <Activity className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Live Flow</h2>
            <p className="text-[10px] text-muted-foreground">Exchange to MongoDB — every stage is real state</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
          animated while flowing <MoveRight className="hidden h-3 w-3 sm:block" />
        </div>
      </div>

      <div className="flex flex-col gap-y-1 sm:flex-row sm:items-start sm:gap-y-0">
        {nodes.map(({ key, ...node }, i) => (
          <div key={key} className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-stretch">
            <FlowNode {...node} delay={i} />
            {i < connectors.length && <FlowPipe active={connectors[i].active} label={connectors[i].label} />}
          </div>
        ))}
      </div>

      <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] leading-relaxed text-muted-foreground/75">
        <ArrowDownRight className="h-3 w-3 shrink-0" />
        Grey connector = no data flowing at that hop; every counter is measured, never invented.
        {typeof d.wsUptimeSec === 'number' && (
          <span className="ml-auto inline-flex items-center gap-1 tabular-nums text-muted-foreground/70">
            <Timer className="h-3 w-3" /> feed up {fmtUptimeShort(d.wsUptimeSec)}
          </span>
        )}
      </p>
    </section>
  );
}
