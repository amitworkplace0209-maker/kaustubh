'use client';

/**
 * Connection Manager — Event inspector.
 *
 * docs/engines/connection-manager.md
 *   §65 LOGGING / §39 INTERNAL EVENT MODEL / §22 observable and diagnosable.
 *   RULE 22 — connection lifecycle must be observable and diagnosable.
 *
 * Bounded in-memory ring served by `connection_engine.recent_events()`. The
 * backend emits a fixed, real event vocabulary (engine.started / engine.stopped /
 * session.attached / session.detached / subscription.acked /
 * subscription.removed / fanout.batch / fanout.failed / broadcast.delivered /
 * persistence.written / persistence.failed / outbox.dropped); the spec's full
 * speculative event model (§39, 23 named events) is NOT realised, so no filter
 * option here describes an event the backend cannot emit.
 *
 * Proper names: `fanout.batch` answers nothing to an operator, so every type
 * is resolved through `cm-identity` into a label plus what the event actually
 * means. The raw token stays visible for anyone auditing against the spec.
 *
 * Field-name contract: rows carry `epoch` (epoch seconds), `ts` (ISO) and
 * `eventType`. An earlier revision read `timestamp`/`time` and `type`/`event_type`,
 * so the Time and Type columns were permanently em-dashes and the "by type"
 * summary collapsed into a single `?` bucket.
 *
 * Filters are debounced and `limit` is a bounded select — the backend enforces
 * `ge=1, le=500`, so a free-text limit could only ever produce a 422.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  CircleMinus,
  Copy,
  Database,
  DatabaseZap,
  Filter as FilterIcon,
  LogIn,
  LogOut,
  Play,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { EmptyState, ErrorState, SectionCard } from '@/components/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CM,
  DASH,
  downloadJson,
  fmtAgo,
  fmtClock,
  fmtIso,
  fmtNum,
  useAutoRefresh,
  useConnectionManagerData,
  useCopy,
  useDebounced,
  useNow,
  type CmEvent,
} from './cm-shared';
import { eventTypeName, shortId } from './cm-identity';
import { EventVolumeChart } from './cm-charts';

/** Backend hard limit is `le=500` (api/ws_gateway.py). */
const LIMIT_OPTIONS = [25, 50, 100, 200, 500] as const;
type LimitOption = (typeof LIMIT_OPTIONS)[number];

const ICONS: Record<string, React.ElementType> = {
  Play,
  Power,
  LogIn,
  LogOut,
  CheckCheck,
  CircleMinus,
  Send,
  Radio,
  Database,
  DatabaseZap,
  Trash2,
  AlertTriangle,
  ScrollText,
};

const LEVEL_STYLE: Record<string, { text: string; border: string; bg: string; label: string; chip: string }> = {
  error: { text: 'text-destructive', border: 'border-l-destructive', bg: 'bg-destructive/[0.06]', label: 'Error', chip: 'bg-destructive/15' },
  critical: { text: 'text-destructive', border: 'border-l-destructive', bg: 'bg-destructive/[0.06]', label: 'Critical', chip: 'bg-destructive/15' },
  fatal: { text: 'text-destructive', border: 'border-l-destructive', bg: 'bg-destructive/[0.06]', label: 'Fatal', chip: 'bg-destructive/15' },
  warn: { text: 'text-warning', border: 'border-l-warning', bg: 'bg-warning/[0.05]', label: 'Warning', chip: 'bg-warning/15' },
  warning: { text: 'text-warning', border: 'border-l-warning', bg: 'bg-warning/[0.05]', label: 'Warning', chip: 'bg-warning/15' },
  info: { text: 'text-info', border: 'border-l-info', bg: 'bg-transparent', label: 'Info', chip: 'bg-info/15' },
};

const levelStyle = (lvl: string | null | undefined) =>
  LEVEL_STYLE[(lvl ?? '').toLowerCase()] ?? {
    text: 'text-muted-foreground',
    border: 'border-l-border',
    bg: 'bg-transparent',
    label: lvl || 'Unknown',
    chip: 'bg-muted',
  };

export default function ConnectionManagerEvents() {
  const data = useConnectionManagerData();
  const now = useNow(1000);

  const [level, setLevel] = useState('');
  const [eventType, setEventType] = useState('');
  const [channel, setChannel] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [limit, setLimit] = useState<LimitOption>(100);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  const dLevel = useDebounced(level);
  const dEventType = useDebounced(eventType);
  const dChannel = useDebounced(channel);
  const dConnectionId = useDebounced(connectionId);

  const [rows, setRows] = useState<CmEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { copy, copied } = useCopy();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      q.set('limit', String(limit));
      if (dLevel.trim()) q.set('level', dLevel.trim());
      if (dEventType.trim()) q.set('event_type', dEventType.trim());
      if (dChannel.trim()) q.set('channel', dChannel.trim());
      if (dConnectionId.trim()) q.set('connection_id', dConnectionId.trim());
      const res = await fetch(`${CM.events}?${q.toString()}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        setRows([]);
        return;
      }
      setRows((body.data?.events ?? []) as CmEvent[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [limit, dLevel, dEventType, dChannel, dConnectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Declared after `load` so the auto-refresh poller never captures a TDZ binding.
  const auto = useAutoRefresh(() => void load(), 20000);

  /** Event types actually present in the returned ring — no invented vocabulary. */
  const availableTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of rows) if (e.eventType) set.add(e.eventType);
    return [...set].sort();
  }, [rows]);

  const availableChannels = useMemo(() => {
    const set = new Set<string>();
    for (const e of rows) if (e.channel) set.add(e.channel);
    return [...set].sort();
  }, [rows]);

  const byType = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of rows) m.set(e.eventType || 'unknown', (m.get(e.eventType || 'unknown') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const byLevel = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of rows) m.set(e.level || 'unknown', (m.get(e.level || 'unknown') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  /** Volume over time, bucketed from the real `epoch` values in the ring. */
  const volume = useMemo(() => {
    const timed = rows.filter((r) => r.epoch != null && Number.isFinite(r.epoch));
    if (timed.length < 2) return [];
    const newest = Math.max(...timed.map((r) => r.epoch));
    const oldest = Math.min(...timed.map((r) => r.epoch));
    const span = Math.max(1, newest - oldest);
    const buckets = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(timed.length))));
    const size = span / buckets;
    const out = Array.from({ length: buckets }, (_, i) => ({
      label: fmtClock(oldest + i * size),
      count: 0,
      errors: 0,
    }));
    for (const r of timed) {
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((r.epoch - oldest) / size)));
      out[idx].count += 1;
      const l = (r.level ?? '').toLowerCase();
      if (l === 'error' || l === 'critical' || l === 'fatal' || l === 'warn' || l === 'warning') {
        out[idx].errors += 1;
      }
    }
    return out;
  }, [rows]);

  const stats = useMemo(() => {
    const errs = rows.filter((e) => ['error', 'critical', 'fatal'].includes((e.level ?? '').toLowerCase())).length;
    const warns = rows.filter((e) => ['warn', 'warning'].includes((e.level ?? '').toLowerCase())).length;
    const timed = rows.filter((r) => r.epoch != null && Number.isFinite(r.epoch));
    const span = timed.length
      ? Math.max(...timed.map((r) => r.epoch)) - Math.min(...timed.map((r) => r.epoch))
      : 0;
    return {
      total: rows.length,
      errors: errs,
      warns,
      types: availableTypes.length,
      connections: new Set(rows.map((r) => r.connectionId).filter(Boolean)).size,
      span,
      rate: span > 0 ? rows.length / span : null,
    };
  }, [rows, availableTypes]);

  const hasFilters = Boolean(
    dLevel.trim() || dEventType.trim() || dChannel.trim() || dConnectionId.trim(),
  );

  const clearFilters = () => {
    setLevel('');
    setEventType('');
    setChannel('');
    setConnectionId('');
  };

  const isLive = Boolean(data.connected && data.source === 'realtime');
  const accent = stats.errors > 0 ? 'danger' : stats.warns > 0 ? 'warning' : 'info';
  const wash =
    accent === 'danger'
      ? 'from-destructive/[0.12] via-destructive/[0.03] to-transparent'
      : accent === 'warning'
        ? 'from-warning/[0.12] via-warning/[0.03] to-transparent'
        : 'from-info/[0.12] via-info/[0.03] to-transparent';
  const border =
    accent === 'danger' ? 'border-destructive/35' : accent === 'warning' ? 'border-warning/35' : 'border-info/30';

  return (
    <div className="space-y-5">
      {/* ============================ HERO ============================ */}
      <div className={`cm-sweep relative overflow-hidden rounded-2xl border ${border} bg-gradient-to-br ${wash} p-5 shadow-soft-lg`}>
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
                <ScrollText className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-display sm:text-2xl">Event Inspector</h1>
                <p className="text-xs text-muted-foreground">
                  The engine&apos;s own recorded activity — spec §22 diagnosability
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
                <span className={isLive ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-success' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
                {isLive ? 'LIVE' : data.source === 'api' ? 'SNAPSHOT' : 'OFFLINE'}
              </span>
              {rows.length ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  seq {rows[rows.length - 1].seq} … {rows[0].seq}
                </span>
              ) : null}
              {stats.rate != null ? (
                <span className="inline-flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                  <Timer className="h-3 w-3" aria-hidden />
                  {stats.rate.toFixed(2)} ev/s
                </span>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            <Counter label="Events" value={stats.total} tone="text-foreground" />
            <Counter label="Errors" value={stats.errors} tone={stats.errors > 0 ? 'text-destructive' : 'text-muted-foreground'} />
            <Counter label="Warnings" value={stats.warns} tone={stats.warns > 0 ? 'text-warning' : 'text-muted-foreground'} />
            <Counter label="Types" value={stats.types} tone="text-info" />
            <Counter label="Sessions" value={stats.connections} tone="text-teal" />
          </div>
        </div>

        <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <Button onClick={() => void load()} size="sm" className="gap-1.5" disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </Button>
          <Button
            variant={auto.enabled ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => auto.setEnabled((v) => !v)}
            className="gap-1.5"
          >
            {auto.enabled ? `Auto ${auto.secondsLeft}s` : 'Auto'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void copy(JSON.stringify(rows, null, 2))}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => downloadJson(`connection-events-${rows.length}.json`, rows)}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Export
          </Button>
        </div>
      </div>

      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {data.errors.length ? <ErrorState message={data.errors.join(' · ')} onRetry={data.reload} /> : null}

      {/* ============================ FILTERS ============================ */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/50 p-2.5 backdrop-blur">
        <span className="inline-flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          <FilterIcon className="h-3 w-3" aria-hidden />
          Filters
        </span>

        <FilterField label="Level" value={level} onChange={setLevel} placeholder="info / warn / error" listId="cm-levels">
          <datalist id="cm-levels">
            {byLevel.map(([l]) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </FilterField>

        <FilterField
          label="Event type"
          value={eventType}
          onChange={setEventType}
          placeholder="fanout.batch"
          mono
          listId="cm-event-types"
        >
          <datalist id="cm-event-types">
            {availableTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </FilterField>

        <FilterField label="Channel" value={channel} onChange={setChannel} placeholder="engines" mono listId="cm-channels">
          <datalist id="cm-channels">
            {availableChannels.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </FilterField>

        <FilterField
          label="Connection id"
          value={connectionId}
          onChange={setConnectionId}
          placeholder="exact id"
          mono
        />

        <label className="block">
          <span className="mb-1 block text-[9px] uppercase tracking-wide text-muted-foreground">Limit</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) as LimitOption)}
            aria-label="Row limit"
            className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} rows
              </option>
            ))}
          </select>
        </label>

        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={clearFilters} className="ml-auto gap-1.5">
            <X className="h-3.5 w-3.5" aria-hidden />
            Clear
          </Button>
        ) : (
          <span className="ml-auto text-[10px] text-muted-foreground">
            Debounced — typing does not fire a request per keystroke
          </span>
        )}
      </div>

      {/* ============================ SUMMARY + CHART ============================ */}
      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Event volume" icon={Timer} className="lg:col-span-2">
          {volume.length >= 2 ? (
            <EventVolumeChart points={volume} />
          ) : (
            <EmptyState
              icon={Timer}
              title="Not enough timed events"
              description="A volume profile needs at least two timestamped events in the ring. The backend has not recorded enough to plot one."
            />
          )}
        </SectionCard>

        <SectionCard title="By level" icon={ScrollText}>
          {byLevel.length ? (
            <div className="space-y-2">
              {byLevel.map(([lvl, n]) => {
                const st = levelStyle(lvl);
                const pct = stats.total ? (n / stats.total) * 100 : 0;
                return (
                  <button
                    key={lvl}
                    onClick={() => setLevel(lvl === level ? '' : lvl)}
                    title={lvl === level ? 'Clear this filter' : `Filter by ${lvl}`}
                    className="block w-full text-left"
                  >
                    <div className="mb-1 flex items-center justify-between text-[10px]">
                      <span className={`flex items-center gap-1.5 font-medium ${st.text}`}>
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {st.label}
                      </span>
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {n} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          st.text === 'text-destructive'
                            ? 'bg-destructive'
                            : st.text === 'text-warning'
                              ? 'bg-warning'
                              : 'bg-info'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">No events returned.</p>
          )}
        </SectionCard>
      </div>

      <SectionCard title={`By event type (${byType.length})`} icon={ScrollText}>
        {byType.length ? (
          <div className="flex flex-wrap gap-2">
            {byType.map(([type, n]) => {
              const p = eventTypeName(type);
              const Icon = ICONS[p?.icon ?? ''] ?? ScrollText;
              const active = type === eventType;
              const pct = stats.total ? (n / stats.total) * 100 : 0;
              return (
                <button
                  key={type}
                  onClick={() => setEventType(active ? '' : type)}
                  title={p?.blurb ?? 'Event type not in the known vocabulary — shown verbatim.'}
                  className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-all ${
                    active
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-border/60 bg-muted/30 hover:border-border hover:bg-muted/50'
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />
                  <span className="text-left">
                    <span className="block text-[11px] font-medium leading-tight text-foreground">
                      {p?.label ?? type}
                    </span>
                    <span className="block font-mono text-[9px] leading-tight text-muted-foreground">
                      {type} · {n} ({pct.toFixed(0)}%)
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">No events returned.</p>
        )}
      </SectionCard>

      {/* ============================ EVENT LIST ============================ */}
      <SectionCard
        title={`Event ring (${rows.length})`}
        icon={ScrollText}
        headerRight={
          <span className="text-[10px] text-muted-foreground">newest first · click a row for full detail</span>
        }
      >
        {loading && !rows.length ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="cm-shimmer h-11 rounded-lg border border-border/50 bg-muted/30" />
            ))}
          </div>
        ) : rows.length ? (
          <div className="cm-scroll max-h-[46rem] space-y-1.5 overflow-auto pr-1">
            {rows.map((e, i) => (
              <EventRow
                key={`${e.seq}-${e.epoch}`}
                event={e}
                now={now}
                index={i}
                expanded={expandedSeq === e.seq}
                onToggle={() => setExpandedSeq((prev) => (prev === e.seq ? null : e.seq))}
              />
            ))}
          </div>
        ) : hasFilters ? (
          <EmptyState
            icon={FilterIcon}
            title="No events match the filter"
            description="The ring holds only recent activity for this process; widen or clear the filter."
            action={
              <Button variant="outline" size="sm" onClick={clearFilters} className="gap-1.5">
                <X className="h-3.5 w-3.5" aria-hidden />
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="Event ring is empty"
            description="No events have been recorded by this gateway process yet."
          />
        )}
      </SectionCard>

      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
        Spec §65 prohibits logging credentials, OTPs or tokens; the gateway therefore never records them and this page
        has no secret fields to redact. Spec §39&apos;s full 23-event speculative model is not implemented — the ring
        carries only the real events listed above.
      </p>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex min-w-[62px] flex-col items-center rounded-xl border border-border/50 bg-background/40 px-2.5 py-1.5 backdrop-blur">
      <span className={`font-mono text-lg font-semibold leading-none tabular-nums ${tone}`}>
        {value.toLocaleString('en-IN')}
      </span>
      <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function FilterField({
  label,
  value,
  onChange,
  placeholder,
  mono,
  listId,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  mono?: boolean;
  listId?: string;
  children?: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        list={listId}
        className={`h-8 w-full text-xs ${mono ? 'font-mono' : ''}`}
      />
      {children}
    </label>
  );
}

function EventRow({
  event: e,
  now,
  index,
  expanded,
  onToggle,
}: {
  event: CmEvent;
  now: number;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const p = eventTypeName(e.eventType);
  const Icon = ICONS[p?.icon ?? ''] ?? ScrollText;
  const st = levelStyle(e.level);

  return (
    <div
      className={`cm-rise overflow-hidden rounded-lg border transition-colors ${st.border} ${st.bg} ${
        expanded ? 'border-primary/40' : 'border-border/50 hover:border-border'
      }`}
      style={{ animationDelay: `${Math.min(index * 18, 260)}ms` }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/25"
      >
        <span className="w-14 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {fmtClock(e.epoch)}
        </span>
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${st.text} ${st.chip}`}
          title={st.label}
        >
          <Icon className="h-3 w-3" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium leading-tight text-foreground">
            {p?.label ?? e.eventType ?? DASH}
          </span>
          <span className="block truncate font-mono text-[9px] leading-tight text-muted-foreground">
            {e.eventType || DASH}
          </span>
        </span>
        <span className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground md:block">
          {e.detail || DASH}
        </span>
        <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground lg:block">
          {e.channel || DASH}
        </span>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          {e.epoch ? fmtAgo(e.epoch, now) : DASH}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
          aria-hidden
        />
      </button>

      {expanded ? (
        <div className="border-t border-border/40 bg-card/40 px-3 py-2.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Sequence" value={fmtNum(e.seq)} />
            <Detail label="Level" value={st.label} tone={st.text} />
            <Detail label="Event type" value={e.eventType || DASH} />
            <Detail label="Event id" value={e.eventId || DASH} />
            <Detail label="Clock (IST)" value={fmtClock(e.epoch)} />
            <Detail label="Timestamp (ISO)" value={fmtIso(e.ts)} />
            <Detail label="Channel" value={e.channel || DASH} />
            <Detail label="Connection" value={e.connectionId ? shortId(e.connectionId) : DASH} />
          </div>

          <div className="mt-2.5">
            <div className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">Detail</div>
            <div
              className="break-words rounded-md border border-border/50 bg-background/50 px-2.5 py-1.5 font-mono text-[10px] leading-relaxed"
              title={e.detail}
            >
              {e.detail || DASH}
            </div>
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[10px] italic text-muted-foreground">
              {p?.blurb ?? 'Event type not in the known vocabulary — raw token shown verbatim.'}
            </span>
            {e.connectionId ? (
              <a
                href="/services/connection-manager/connections"
                className="shrink-0 text-[10px] text-primary hover:underline"
              >
                View this session →
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`truncate font-mono text-[10px] ${tone ?? 'text-foreground'}`} title={value}>
        {value}
      </div>
    </div>
  );
}