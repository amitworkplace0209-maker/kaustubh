'use client';

/**
 * Connection Manager — Configuration (read-only) + field availability.
 *
 * docs/engines/connection-manager.md
 *   §10 FIELD REQUIREMENT MANAGEMENT → availability vocabulary
 *        AVAILABLE / UNAVAILABLE / PARTIAL / NOT_READY / SOURCE_ERROR
 *        "DO NOT fabricate the field."
 *   §11 SOURCE MANAGEMENT → source priority
 *   §18 FIELD REQUIREMENT / §24 DATA DELIVERY FILTERING → aliases
 *   §56 STALE DATA PROTECTION → freshness thresholds
 *   §26 BACKPRESSURE → policy + queue limit
 *   §38 API CAN STILL BE USED → configuration is a legitimate API use
 *
 * Read-only. `connection_engine.config()` exposes no write path, so this page
 * presents the resolved configuration and offers nothing that implies it can
 * be changed from here.
 *
 * Proper names: `P1`, `WATCHLIST_LIGHT`, `DROP_OLDEST` and `WEBSOCKET` are
 * resolved into labels plus an explanation via `cm-identity`. Every mapping
 * table there is verified against `connection_engine/channels.py` and
 * `connection_engine.py`; an unmapped token is shown verbatim and flagged.
 *
 * Field-name contract: `GET /api/realtime/fields` returns an OBJECT
 * `{ sources, ws, features, aliases }`. An earlier revision ran it through
 * `Array.isArray(...)`, so the field catalogue was permanently empty and
 * displayed "0 fields". Conversely, nine config keys this page used to read
 * (`eventSequenceEnabled`, `idleTimeoutS`, `sourceEnum`, the delivery limits,
 * and the per-channel `kind`/`priority`/`burstWindowS`) are simply not emitted
 * by the backend; they are gone here rather than left as permanent em-dashes.
 */

import { useMemo, useState } from 'react';
import {
  Boxes,
  Check,
  Copy,
  Gauge,
  Layers,
  ListTree,
  Radio,
  RefreshCw,
  Ruler,
  Search,
  Settings2,
  Waypoints,
  X,
  Zap,
} from 'lucide-react';
import { EmptyState, ErrorState, SectionCard, StatusBadge } from '@/components/design-system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DASH,
  KV,
  KVGrid,
  downloadJson,
  fmtNum,
  fmtSeconds,
  useAutoRefresh,
  useConnectionManagerData,
  useCopy,
  type CmConfig,
  type CmFields,
} from './cm-shared';
import {
  FIELD_GROUP_INFO,
  channelPurpose,
  consumerTypeName,
  deliveryMethodName,
  fieldKindHint,
  policyName,
  priorityName,
  profileName,
  sourceName,
  type ProperName,
} from './cm-identity';

export default function ConnectionManagerConfiguration() {
  const data = useConnectionManagerData();
  const [fieldQuery, setFieldQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<'all' | 'ws' | 'features' | 'aliases'>('all');
  const { copy, copied } = useCopy();
  const auto = useAutoRefresh(data.reload, 20000);

  const cfg: CmConfig | null = data.config;
  const fields: CmFields | null = data.fields;

  const marketChannels = useMemo(() => Object.entries(cfg?.channels?.market ?? {}), [cfg]);
  const stateChannels = useMemo(() => Object.entries(cfg?.channels?.state ?? {}), [cfg]);

  const fieldGroups = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    const match = (list: string[] | undefined) => (list ?? []).filter((f) => !q || f.toLowerCase().includes(q));
    return {
      ws: match(fields?.ws),
      features: match(fields?.features),
      sources: fields?.sources ?? [],
      aliases: Object.entries(fields?.aliases ?? {}).filter(
        ([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
      ),
    };
  }, [fields, fieldQuery]);

  const visibleGroups = useMemo(
    () => (groupFilter === 'all' ? ['ws', 'features', 'aliases'] : [groupFilter]),
    [groupFilter],
  );

  const totalCatalogue = (fields?.ws?.length ?? 0) + (fields?.features?.length ?? 0);
  const matchedCount = fieldGroups.ws.length + fieldGroups.features.length + fieldGroups.aliases.length;

  // Field kind histogram — derived from the names the backend published.
  const kindBreakdown = useMemo(() => {
    const all = [...(fields?.ws ?? []), ...(fields?.features ?? [])];
    const m = new Map<string, number>();
    for (const f of all) {
      const k = fieldKindHint(f) ?? 'other';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [fields]);

  const freshnessBar = useMemo(() => {
    const fresh = cfg?.freshnessThresholds?.freshMaxAgeS ?? null;
    const delayed = cfg?.freshnessThresholds?.delayedMaxAgeS ?? null;
    const stale = cfg?.staleAfterS ?? null;
    if (fresh == null || delayed == null) return null;
    const total = Math.max(delayed, stale ?? delayed, 1);
    return [
      { label: 'FRESH', to: fresh, tone: 'bg-success', text: 'text-success' },
      { label: 'DELAYED', to: delayed, tone: 'bg-warning', text: 'text-warning' },
      { label: 'STALE', to: stale ?? total, tone: 'bg-destructive', text: 'text-destructive' },
    ].filter((b) => b.to > 0);
  }, [cfg]);

  const isLive = Boolean(data.connected && data.source === 'realtime');

  if (data.loading) {
    return (
      <div className="space-y-4">
        <div className="cm-shimmer h-44 rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 to-transparent" />
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="cm-shimmer h-40 rounded-xl border border-border/60 bg-card/40" />
          ))}
        </div>
      </div>
    );
  }

  const healthy = Boolean(cfg && fields);

  return (
    <div className="space-y-5">
      {/* ============================ HERO ============================ */}
      <div
        className={`cm-sweep relative overflow-hidden rounded-2xl border ${
          healthy ? 'border-primary/30' : 'border-destructive/35'
        } bg-gradient-to-br from-primary/[0.13] via-primary/[0.03] to-transparent p-5 shadow-soft-lg`}
      >
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
                <Settings2 className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-display sm:text-2xl">Configuration</h1>
                <p className="text-xs text-muted-foreground">
                  Resolved gateway configuration &amp; field catalogue — read-only (spec §38)
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur">
                <span className={isLive ? 'h-1.5 w-1.5 animate-pulse rounded-full bg-success' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'} />
                {isLive ? 'LIVE' : data.source === 'api' ? 'SNAPSHOT' : 'OFFLINE'}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                <Check className="h-3 w-3" aria-hidden />
                Read-only · no write path
              </span>
              {!cfg ? <StatusBadge status="danger" label="config unavailable" /> : null}
              {!fields ? <StatusBadge status="danger" label="fields unavailable" /> : null}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            <Counter label="Market ch" value={marketChannels.length} tone="text-primary" />
            <Counter label="State ch" value={stateChannels.length} tone="text-teal" />
            <Counter label="Fields" value={totalCatalogue} tone="text-info" />
            <Counter label="Aliases" value={Object.keys(cfg?.fieldSources?.aliases ?? {}).length} tone="text-purple" />
            <Counter label="Queue limit" value={cfg?.backpressure?.queueLimit ?? null} tone="text-warning" />
          </div>
        </div>

        <div className="relative mt-4 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <Button onClick={data.reload} size="sm" className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
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
            onClick={() => void copy(JSON.stringify({ config: cfg, fields }, null, 2))}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => downloadJson('connection-manager-config.json', { config: cfg, fields })}
          >
            <Zap className="h-3.5 w-3.5" aria-hidden />
            Export
          </Button>
        </div>
      </div>

      {data.errors.length ? <ErrorState message={data.errors.join(' · ')} onRetry={data.reload} /> : null}

      {/* ============================ RUNTIME ============================ */}
      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title="Envelope & runtime" icon={Settings2}>
          {cfg ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <VersionPill label="Envelope v" value={String(cfg.envelopeVersion ?? DASH)} />
                <VersionPill label="Schema v" value={String(cfg.schemaVersion ?? DASH)} />
              </div>
              <KVGrid cols={1}>
                <KV label="Heartbeat interval" value={fmtSeconds(cfg.heartbeatIntervalS)} />
                <KV label="Stale after" value={fmtSeconds(cfg.staleAfterS)} />
                <KV label="Fresh max age" value={fmtSeconds(cfg.freshnessThresholds?.freshMaxAgeS)} />
                <KV label="Delayed max age" value={fmtSeconds(cfg.freshnessThresholds?.delayedMaxAgeS)} />
              </KVGrid>

              {/* Freshness band — real thresholds as a proportion bar */}
              {freshnessBar ? (
                <div className="border-t border-border/50 pt-2.5">
                  <div className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                    Freshness bands — spec §56
                  </div>
                  <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
                    {freshnessBar.map((b, i) => (
                      <div
                        key={b.label}
                        className={`h-full ${b.tone} ${i === 0 ? 'rounded-l-full' : ''} ${i === freshnessBar.length - 1 ? 'rounded-r-full' : ''}`}
                        style={{ width: `${Math.max(8, (b.to / Math.max(...freshnessBar.map((x) => x.to))) * 100)}%` }}
                        title={`${b.label} up to ${b.to}s`}
                      />
                    ))}
                  </div>
                  <div className="mt-1 flex justify-between gap-2">
                    {freshnessBar.map((b) => (
                      <span key={b.label} className={`font-mono text-[9px] tabular-nums ${b.text}`}>
                        {b.label} ≤ {b.to}s
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="border-t border-border/50 pt-2 text-[10px] leading-relaxed text-muted-foreground">
                Spec §56: freshness thresholds decide FRESH / DELAYED / STALE / NO_DATA. Connection health stays
                separate from data quality (spec §28).
              </p>
            </div>
          ) : (
            <Unavailable />
          )}
        </SectionCard>

        <SectionCard title="Backpressure & delivery" icon={Ruler}>
          {cfg ? (
            <div className="space-y-3">
              <div
                className="rounded-lg border border-border/50 bg-background/40 px-3 py-2"
                title={policyName(cfg.backpressure?.policy)?.blurb}
              >
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Policy</div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-warning" aria-hidden />
                  <span className="text-sm font-semibold">
                    {policyName(cfg.backpressure?.policy)?.label ?? cfg.backpressure?.policy ?? DASH}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                  {policyName(cfg.backpressure?.policy)?.blurb ?? 'Policy not in the known vocabulary.'}
                </p>
              </div>

              <KVGrid cols={1}>
                <KV label="Queue limit" value={fmtNum(cfg.backpressure?.queueLimit)} />
                <KV
                  label="Delivery methods"
                  value={
                    <span className="flex flex-wrap justify-end gap-1">
                      {(cfg.deliveryMethods ?? []).map((m) => (
                        <NameChip key={m} name={deliveryMethodName(m)} />
                      ))}
                      {!(cfg.deliveryMethods ?? []).length ? DASH : null}
                    </span>
                  }
                  mono={false}
                />
              </KVGrid>

              <div className="border-t border-border/50 pt-2.5">
                <div className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  Consumer types — spec §8
                </div>
                <div className="space-y-1">
                  {(cfg.consumerTypes ?? []).map((t) => {
                    const p = consumerTypeName(t);
                    return (
                      <div
                        key={t}
                        title={p?.blurb}
                        className="flex items-center justify-between gap-2 rounded border border-border/50 px-2 py-1"
                      >
                        <span className="text-[11px] font-medium">{p?.label ?? t}</span>
                        <span className="font-mono text-[9px] text-muted-foreground">{t}</span>
                      </div>
                    );
                  })}
                  {!(cfg.consumerTypes ?? []).length ? (
                    <p className="text-[11px] text-muted-foreground">No consumer types reported.</p>
                  ) : null}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  Spec §8 defines eleven consumer types; the gateway currently reports only{' '}
                  <span className="font-mono">{(cfg.consumerTypes ?? []).join(', ') || DASH}</span>. The full
                  vocabulary is not registered, so it is not displayed as if it were.
                </p>
              </div>
            </div>
          ) : (
            <Unavailable />
          )}
        </SectionCard>

        <SectionCard title="Sources & aliases" icon={Boxes}>
          {cfg ? (
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                  Resolved source priority — spec §11
                </div>
                <div className="space-y-1">
                  {(cfg.fieldSources?.sources ?? []).map((s, i) => {
                    const p = sourceName(s);
                    return (
                      <div
                        key={s}
                        title={p?.blurb}
                        className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5"
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary/15 font-mono text-[9px] font-bold text-primary">
                          {i + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-[11px] font-medium">{p?.label ?? s}</div>
                          <div className="truncate font-mono text-[9px] text-muted-foreground">{s}</div>
                        </div>
                      </div>
                    );
                  })}
                  {!(cfg.fieldSources?.sources ?? []).length ? (
                    <p className="text-[11px] text-muted-foreground">No sources reported.</p>
                  ) : null}
                </div>
              </div>

              <div className="border-t border-border/50 pt-2.5">
                <div className="mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
                  <span>Field aliases — spec §24</span>
                  <span className="font-mono tabular-nums">
                    {Object.keys(cfg.fieldSources?.aliases ?? {}).length}
                  </span>
                </div>
                {cfg.fieldSources?.aliases && Object.keys(cfg.fieldSources.aliases).length ? (
                  <div className="space-y-1">
                    {Object.entries(cfg.fieldSources.aliases).map(([alias, target]) => (
                      <div key={alias} className="flex items-center gap-1.5 text-[10px]">
                        <span className="shrink-0 font-mono text-foreground">{alias}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="min-w-0 truncate font-mono text-muted-foreground" title={target}>
                          {target}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">No aliases configured.</p>
                )}
              </div>
            </div>
          ) : (
            <Unavailable />
          )}
        </SectionCard>
      </div>

      {/* ============================ CHANNELS ============================ */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={`Market channels (${marketChannels.length})`} icon={Waypoints}>
          {marketChannels.length ? (
            <div className="space-y-2">
              {marketChannels.map(([name, c]) => {
                const pri = priorityName(c.priority);
                const prof = profileName(c.profileId);
                const interval = c.minIntervalS;
                return (
                  <div
                    key={name}
                    className="group rounded-lg border border-border/50 bg-background/40 px-3 py-2 transition-colors hover:border-border"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        <span className="font-mono text-xs font-semibold">{name}</span>
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          every {fmtSeconds(interval)}
                        </span>
                        <StatusBadge status={priorityTone(c.priority)} label={pri?.label ?? c.priority ?? DASH} />
                      </div>
                    </div>

                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {channelPurpose(name) ?? 'Purpose not described by the backend.'}
                    </p>

                    <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border/40 pt-1.5">
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Profile</span>
                      <span title={prof?.blurb} className="font-mono text-[10px]">
                        {c.profileId || DASH}
                        {prof ? <span className="ml-1 text-muted-foreground">· {prof.label}</span> : null}
                      </span>
                    </div>

                    {/* Rate gauge — interval mapped onto a 0–2s scale for a visual read */}
                    {interval != null ? (
                      <div className="mt-1.5">
                        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary/70 transition-all duration-500"
                            style={{ width: `${Math.min(100, (interval / 2) * 100)}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <Unavailable />
          )}
          <p className="mt-2.5 border-t border-border/50 pt-2 text-[10px] leading-relaxed text-muted-foreground">
            Spec §25: delivery rate policy must not silently drop data a trading consumer needs, so each market
            channel declares its own minimum interval and profile.
          </p>
        </SectionCard>

        <SectionCard title={`State channels (${stateChannels.length})`} icon={Layers}>
          {stateChannels.length ? (
            <div className="space-y-2">
              {stateChannels.map(([name, description]) => (
                <div
                  key={name}
                  className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-background/40 px-3 py-2 transition-colors hover:border-border"
                >
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-teal" />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs font-semibold">{name}</div>
                    <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                      {description || DASH}
                    </div>
                    <div className="mt-0.5 text-[10px] italic text-muted-foreground/70">
                      {channelPurpose(name) ?? 'No consumer-facing summary recorded.'}
                    </div>
                  </div>
                  <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[8px] uppercase text-muted-foreground">
                    event
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Unavailable />
          )}
          <p className="mt-2.5 border-t border-border/50 pt-2 text-[10px] leading-relaxed text-muted-foreground">
            State channels carry lifecycle events rather than throttled market data, so the backend describes them
            with a plain event-pattern string instead of a rate profile.
          </p>
        </SectionCard>
      </div>

      {/* ============================ FIELD CATALOGUE ============================ */}
      <SectionCard
        title="Field availability catalogue — spec §10"
        icon={ListTree}
        headerRight={
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {totalCatalogue} fields · {matchedCount} shown
          </span>
        }
      >
        {!fields ? (
          <Unavailable />
        ) : (
          <div className="space-y-4">
            {/* Search + group filter */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={fieldQuery}
                  onChange={(e) => setFieldQuery(e.target.value)}
                  placeholder="Filter fields or aliases…"
                  aria-label="Filter fields"
                  className="h-8 pl-8 font-mono text-xs"
                />
              </div>
              <div className="flex rounded-lg border border-border/60 p-0.5">
                {(['all', 'ws', 'features', 'aliases'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGroupFilter(g)}
                    className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                      groupFilter === g ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {g === 'all' ? 'All' : g === 'ws' ? 'Market' : g === 'features' ? 'Features' : 'Aliases'}
                  </button>
                ))}
              </div>
              {fieldQuery ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setFieldQuery('');
                    setGroupFilter('all');
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  Reset
                </Button>
              ) : null}
            </div>

            {/* Kind histogram — derived from published names, not availability */}
            {kindBreakdown.length ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2">
                <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                  Field kinds
                </span>
                {kindBreakdown.map(([kind, n]) => (
                  <span key={kind} className="inline-flex items-center gap-1 text-[10px]">
                    <span className="h-1.5 w-1.5 rounded-full bg-info" />
                    <span className="text-muted-foreground">{KIND_LABEL[kind] ?? kind}</span>
                    <span className="font-mono tabular-nums">{n}</span>
                  </span>
                ))}
                <span className="ml-auto text-[9px] italic text-muted-foreground/70">
                  grouped by name — not an availability verdict
                </span>
              </div>
            ) : null}

            {/* WS fields */}
            {visibleGroups.includes('ws') ? (
              <FieldGroup
                title={FIELD_GROUP_INFO.ws.label}
                blurb={FIELD_GROUP_INFO.ws.blurb}
                count={fieldGroups.ws.length}
                icon={Radio}
                tone="info"
                values={fieldGroups.ws}
              />
            ) : null}

            {/* Feature fields */}
            {visibleGroups.includes('features') ? (
              <FieldGroup
                title={FIELD_GROUP_INFO.features.label}
                blurb={FIELD_GROUP_INFO.features.blurb}
                count={fieldGroups.features.length}
                icon={Gauge}
                tone="purple"
                values={fieldGroups.features}
              />
            ) : null}

            {/* Aliases */}
            {visibleGroups.includes('aliases') && fieldGroups.aliases.length ? (
              <div>
                <div className="mb-1.5 flex items-center gap-2">
                  <Layers className="h-3 w-3 text-teal" aria-hidden />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {FIELD_GROUP_INFO.aliases.label}
                  </span>
                  <span className="rounded-full border border-border/60 px-1.5 py-px font-mono text-[9px] tabular-nums">
                    {fieldGroups.aliases.length}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{FIELD_GROUP_INFO.aliases.blurb}</span>
                </div>
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {fieldGroups.aliases.map(([alias, target]) => (
                    <div
                      key={alias}
                      className="flex items-center gap-1.5 rounded border border-border/50 bg-background/40 px-2 py-1 text-[10px]"
                    >
                      <span className="shrink-0 font-mono text-foreground">{alias}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="min-w-0 truncate font-mono text-muted-foreground" title={target}>
                        {target}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {!matchedCount ? (
              <EmptyState
                icon={Search}
                title="No field matches"
                description="Clear the search box or switch the group filter."
              />
            ) : null}

            <p className="border-t border-border/50 pt-2.5 text-[10px] leading-relaxed text-muted-foreground">
              Spec §10 and RULE 14: a requested field is never fabricated. Availability resolves to{' '}
              <span className="font-mono">AVAILABLE / UNAVAILABLE / PARTIAL / NOT_READY / SOURCE_ERROR</span> — this
              page lists the catalogue the resolver checks against, not a fabricated availability verdict.
            </p>
          </div>
        )}
      </SectionCard>

      {!cfg && !fields ? (
        <SectionCard title="Configuration unavailable" icon={Settings2}>
          <EmptyState
            icon={Settings2}
            title="No configuration returned"
            description="Neither the configuration nor the field catalogue could be read. No defaults are substituted."
          />
        </SectionCard>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  market: 'market quotes',
  feature: 'computed features',
  time: 'timestamps',
  state: 'state / health',
  other: 'other',
};

// ===========================================================================
// SMALL PARTS
// ===========================================================================

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: string;
}) {
  return (
    <div className="flex min-w-[62px] flex-col items-center rounded-xl border border-border/50 bg-background/40 px-2.5 py-1.5 backdrop-blur">
      <span className={`font-mono text-lg font-semibold leading-none tabular-nums ${value == null ? 'text-muted-foreground' : tone}`}>
        {value == null ? '—' : value.toLocaleString('en-IN')}
      </span>
      <span className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  );
}

function VersionPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function NameChip({ name }: { name: ProperName | null }) {
  if (!name) return <span className="text-[11px] text-muted-foreground">{DASH}</span>;
  return (
    <span
      title={name.blurb}
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${
        name.known ? 'border-info/30 bg-info/10 text-info' : 'border-warning/40 bg-warning/10 text-warning'
      }`}
    >
      {name.label}
    </span>
  );
}

function FieldGroup({
  title,
  blurb,
  count,
  icon: Icon,
  tone,
  values,
}: {
  title: string;
  blurb: string;
  count: number;
  icon: React.ElementType;
  tone: 'info' | 'purple';
  values: string[];
}) {
  const toneIcon = tone === 'purple' ? 'text-purple' : 'text-info';
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Icon className={`h-3 w-3 ${toneIcon}`} aria-hidden />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        <span className="rounded-full border border-border/60 px-1.5 py-px font-mono text-[9px] tabular-nums">
          {count}
        </span>
        <span className="text-[10px] text-muted-foreground">{blurb}</span>
      </div>
      {values.length ? (
        <div className="flex flex-wrap gap-1">
          {values.map((f) => {
            const kind = fieldKindHint(f);
            return (
              <span
                key={f}
                title={kind ? `Grouped as ${KIND_LABEL[kind] ?? kind} by name.` : 'Field name does not match a known pattern.'}
                className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10"
              >
                {f}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">no match</p>
      )}
    </div>
  );
}

function Unavailable() {
  return (
    <p className="py-2 text-[11px] text-muted-foreground">
      Not available from the backend. Nothing is substituted for it.
    </p>
  );
}

function priorityTone(priority: string | undefined): 'success' | 'warning' | 'info' | 'neutral' {
  switch ((priority ?? '').toUpperCase()) {
    case 'P0':
      return 'warning';
    case 'P1':
      return 'info';
    case 'P2':
    case 'P3':
      return 'neutral';
    default:
      return 'neutral';
  }
}