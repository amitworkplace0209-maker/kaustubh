'use client';

/**
 * SERVICES → System → Engine Profile (full detail page).
 *
 * Rendered at BOTH /services/system/[engineId] (canonical detail page) and
 * /services/system/profile/[engineId] (profile alias). Sections:
 *
 *  hero profile card → actions → stat cards → chart cards → detail
 *  dropdowns (accordion) → related engines → workspace + back links.
 *
 * Real backend data only (Engine Registry API). Missing values render as N/A.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertCircle, ArrowLeft, ArrowUpRight, CheckCircle2,
  ChevronRight, Clock, ExternalLink, HeartPulse, Inbox, Layers,
  Play, RefreshCw, RotateCw, Server, Square, UserRound,
} from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  CATEGORY_COLORS, CATEGORY_ICONS, ENGINE_WORKSPACE_LINKS, ENGINES_API,
  HEALTH_COLORS, STATE_COLORS, engineProfileHref, fmtAgo, fmtEpoch, fmtInt,
  fmtValue, isRunningState, loadEnginesOverview, postEngineAction,
  type EngineActivityEntry, type EngineDependencies, type EngineErrorEntry,
  type EnginesDocument, type EngineStatus,
} from '@/lib/system-engines';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';
import { useOneShot } from '@/lib/engine-realtime';
import { EngineSettingsPanel } from '@/components/engines/engine-settings-panel';
import { EngineActivityChart } from './charts';
import { EngineCountersDonut } from './charts';
import { EngineCustomMetricsChart } from './charts';

const API = ENGINES_API;

function StatCard({
  label, value, sub, icon: Icon, tone,
}: {
  label: string; value: string; sub?: string; icon: React.ElementType; tone?: string;
}) {
  return (
    <Card className="shadow-soft">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{label}</span>
          <Icon className={`h-5 w-5 ${tone ?? 'text-primary'}`} />
        </div>
        <div className="mt-1 truncate font-mono text-2xl font-bold" title={value}>{value}</div>
        {sub && <p className="truncate text-xs text-muted-foreground" title={sub}>{sub}</p>}
      </CardContent>
    </Card>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export default function EngineProfilePage({ engineId }: { engineId: string }) {
  // The live engine status + the fleet come from the ONE `engines` WebSocket
  // subscription (the whole control plane rides in one frame). Errors /
  // activity / dependency history are per-engine detail loads — one-shot REST
  // (mount + manual refresh), never a timer.
  const { data: controlPlane, live, error: liveError } = useRealtimeChannel<EnginesDocument>('engines', {
    fallback: loadEnginesOverview,
    fallbackKey: 'engines-overview',
    fallbackMs: 20000,
  });

  const engine = useMemo<EngineStatus | null>(() => {
    if (!engineId) return null;
    return controlPlane?.engines?.[engineId] ?? null;
  }, [controlPlane, engineId]);

  const statusPath = engineId ? `${API}/${encodeURIComponent(engineId)}` : null;
  const { data: errors, refresh: refreshErrors } = useOneShot<EngineErrorEntry[]>(
    engineId ? `${statusPath}/errors?limit=20` : null,
    true,
  );
  const { data: activity, refresh: refreshActivity } = useOneShot<EngineActivityEntry[]>(
    engineId ? `${statusPath}/activity?limit=30` : null,
    true,
  );
  const { data: deps, refresh: refreshDeps } = useOneShot<EngineDependencies>(
    engineId ? `${statusPath}/dependencies` : null,
    true,
  );

  const fleet = useMemo<EngineStatus[] | null>(
    () => (controlPlane ? Object.values(controlPlane.engines ?? {}) : null),
    [controlPlane],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refreshAll = useCallback(() => {
    refreshErrors();
    refreshActivity();
    refreshDeps();
  }, [refreshErrors, refreshActivity, refreshDeps]);

  const run = useCallback(async (action: string, confirmed = false) => {
    setBusy(action);
    setMsg(null);
    const r = await postEngineAction(
      `${API}/${encodeURIComponent(engineId)}/${action}`,
      action === 'stop' ? { confirm: confirmed } : undefined,
    );
    setBusy(null);
    if (!r.ok && r.requiresConfirmation) {
      setNeedsConfirm(true);
      setMsg(r.error ?? 'Stopping this engine needs confirmation');
    } else {
      setNeedsConfirm(false);
      setMsg(r.ok ? `${action} accepted` : (r.error ?? `${action} failed`));
    }
    setTimeout(refreshAll, 600);
  }, [engineId, refreshAll]);

  const related = useMemo(() => {
    if (!fleet || !engine) return [];
    return fleet
      .filter((e) => e.engineId !== engine.engineId && e.engineCategory === engine.engineCategory)
      .slice(0, 6);
  }, [fleet, engine]);

  const Icon = (engine && CATEGORY_ICONS[engine.engineCategory]) || Server;
  const running = engine ? isRunningState(engine.state) : false;
  const isError = engine ? ['ERROR', 'DEPENDENCY_ERROR'].includes(engine.state) : false;
  const workspace = ENGINE_WORKSPACE_LINKS[engineId];
  const customEntries = Object.entries(engine?.metrics?.custom ?? {});
  const configEntries = Object.entries(engine?.configSummary ?? {});
  const errorList = Array.isArray(errors) ? errors : (engine?.recentErrors ?? []);
  const activityList = Array.isArray(activity) ? activity : [];

  /* Loading / not-found states — honest, never fabricated */
  if (!engine && !liveError) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-64 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted/60" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-muted/60" />
          ))}
        </div>
        <p className="text-sm text-muted-foreground">Loading engine profile…</p>
      </div>
    );
  }

  if (!engine && liveError) {
    return (
      <div className="space-y-4">
        <Button size="sm" variant="outline" asChild>
          <Link href="/services/system"><ArrowLeft className="mr-1 h-3 w-3" /> Back to Control Center</Link>
        </Button>
        <Card className="border-destructive/30">
          <CardContent className="flex items-start gap-3 p-6 text-sm">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Engine &lsquo;{engineId}&rsquo; not found or unreachable</p>
              <p className="mt-1 text-xs text-muted-foreground">{liveError}. Retrying automatically…</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={refreshAll}>
                <RefreshCw className="mr-1 h-3 w-3" /> Retry now
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Link href="/services/system" className="hover:text-foreground">System</Link>
          <ChevronRight className="h-3 w-3" />
          <span className="font-medium text-foreground">{engine?.engineName ?? engineId}</span>
        </nav>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href="/services/system"><ArrowLeft className="mr-1 h-3 w-3" /> Control Center</Link>
          </Button>
          {workspace && (
            <Button size="sm" variant="default" asChild>
              <Link href={workspace.href}><ArrowUpRight className="mr-1 h-3 w-3" /> Open {workspace.label}</Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={refreshAll} title="Refresh now">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Badge variant="outline" className={live ? 'border-success/40 text-success' : 'border-warning/40 text-warning'} title={live ? 'Status pushed over the WebSocket' : 'REST fallback polling'}>
            {live ? 'Live · WebSocket' : 'REST fallback'}
          </Badge>
        </div>
      </div>

      {/* Hero profile card */}
      <Card className="shadow-soft overflow-hidden">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-muted ${CATEGORY_COLORS[engine!.engineCategory] ?? 'text-muted-foreground'}`}>
            <Icon className="h-8 w-8" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{engine!.engineName}</h1>
              <Badge className={STATE_COLORS[engine!.state] || STATE_COLORS.UNKNOWN}>{engine!.state}</Badge>
              <Badge variant="outline" className={HEALTH_COLORS[engine!.health] || 'text-muted-foreground'}>
                {engine!.health || 'N/A'}
              </Badge>
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {engine!.engineId} · v{engine!.version || 'N/A'} · {engine!.engineCategory || 'N/A'}
            </p>
            {engine!.healthReason && (
              <p className="mt-1 text-xs text-muted-foreground">Reason: {engine!.healthReason}</p>
            )}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 text-xs sm:text-right">
            <span className="text-muted-foreground">Started</span>
            <span className="font-mono">{fmtEpoch(engine!.startedAt)}</span>
            <span className="text-muted-foreground">Uptime</span>
            <span className="font-mono">{fmtAgo(engine!.startedAtAgo)}</span>
            <span className="text-muted-foreground">Heartbeat</span>
            <span className="font-mono">{fmtAgo(engine!.heartbeatAge)}</span>
            <span className="text-muted-foreground">Connection</span>
            <span>{engine!.connectionState || 'N/A'}</span>
          </div>
        </div>
        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-5 py-3">
          {!running && (
            <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run('start')}>
              {busy === 'start' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />} Start
            </Button>
          )}
          {running && !isError && !needsConfirm && (
            <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run('stop')}>
              {busy === 'stop' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Square className="mr-1 h-3 w-3" />} Stop
            </Button>
          )}
          {needsConfirm && (
            <Button size="sm" variant="destructive" disabled={busy != null} onClick={() => run('stop', true)}>
              <AlertCircle className="mr-1 h-3 w-3" /> Confirm stop
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run('restart')}>
            {busy === 'restart' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <RotateCw className="mr-1 h-3 w-3" />} Restart
          </Button>
          <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run('heartbeat')}>
            <HeartPulse className="mr-1 h-3 w-3" /> Heartbeat
          </Button>
          {msg && (
            <span className={`text-xs ${msg.includes('accepted') ? 'text-success' : 'text-muted-foreground'}`}>{msg}</span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">Auto-refreshing every 8s</span>
        </div>
      </Card>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Events" value={fmtInt(engine!.metrics?.eventCount)} sub="lifetime operations" icon={Activity} tone="text-teal-500" />
        <StatCard
          label="Errors" value={fmtInt(engine!.metrics?.errorCount)} sub={`${errorList.length} recent listed`}
          icon={AlertCircle} tone={(engine!.metrics?.errorCount ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground'}
        />
        <StatCard label="Warnings" value={fmtInt(engine!.metrics?.warningCount)} sub="lifetime" icon={AlertCircle} tone="text-amber-500" />
        <StatCard label="Queue" value={fmtInt(engine!.metrics?.queueSize)} sub="pending items" icon={Inbox} tone="text-sky-500" />
        <StatCard
          label="Workload" value={engine!.metrics?.workload != null ? `${engine!.metrics.workload}%` : 'N/A'}
          sub="current load" icon={Layers} tone="text-violet-500"
        />
        <StatCard
          label="Last op" value={engine!.metrics?.lastOperationDurationMs != null ? `${engine!.metrics.lastOperationDurationMs}ms` : 'N/A'}
          sub={fmtEpoch(engine!.metrics?.lastOperationAt)} icon={Clock} tone="text-emerald-500"
        />
      </div>

      {/* Settings — the engine's own declared, writable schema plus whatever it
          reports read-only. Bound to the real config endpoints. */}
      <EngineSettingsPanel engineId={engineId} engineName={engine?.engineName} />

      {/* Chart cards */}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Engine Charts</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <EngineActivityChart entries={activityList} />
          <EngineCountersDonut engine={engine} />
          <EngineCustomMetricsChart engine={engine} />
        </div>
      </div>

      {/* Detail dropdowns */}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Engine Details</h2>
        <Card className="shadow-soft px-4">
          <Accordion type="multiple" defaultValue={['deps', 'errors']} className="w-full">
            <AccordionItem value="deps">
              <AccordionTrigger className="text-sm">
                Dependencies & Dependents
                <Badge variant="outline" className="ml-2 text-[10px]">
                  {(deps?.dependencies?.length ?? engine!.dependencies.length)} deps · {(deps?.dependents?.length ?? engine!.dependents.length)} dependents
                </Badge>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Depends on</p>
                    {(deps?.dependencies ?? engine!.dependencies).length === 0 && (
                      <p className="text-xs text-muted-foreground">No dependencies declared.</p>
                    )}
                    <div className="space-y-1">
                      {(deps?.dependencies ?? engine!.dependencies).map((d) => {
                        const st = deps?.statuses?.[d];
                        return (
                          <Link key={d} href={engineProfileHref(d)} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs hover:border-primary">
                            <span className="font-mono">{d}</span>
                            <span className="flex items-center gap-1">
                              {st ? (
                                <>
                                  <Badge variant="outline" className={`text-[10px] ${st.state === 'RUNNING' || st.state === 'HEALTHY' ? 'text-success' : 'text-muted-foreground'}`}>{st.state}</Badge>
                                  <Badge variant="outline" className="text-[10px]">{st.health}</Badge>
                                </>
                              ) : <span className="text-muted-foreground">profile →</span>}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Required by (dependents)</p>
                    {(deps?.dependents ?? engine!.dependents).length === 0 && (
                      <p className="text-xs text-muted-foreground">No dependents declared.</p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {(deps?.dependents ?? engine!.dependents).map((d) => (
                        <Link key={d} href={engineProfileHref(d)}>
                          <Badge variant="outline" className="text-[11px] hover:border-primary hover:text-primary">{d}</Badge>
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="metrics">
              <AccordionTrigger className="text-sm">
                Metrics & Custom Values
                <Badge variant="outline" className="ml-2 text-[10px]">{customEntries.length} custom</Badge>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="divide-y divide-border/50">
                    <DetailRow label="Events"><span className="font-mono">{fmtInt(engine!.metrics?.eventCount)}</span></DetailRow>
                    <DetailRow label="Errors"><span className="font-mono">{fmtInt(engine!.metrics?.errorCount)}</span></DetailRow>
                    <DetailRow label="Warnings"><span className="font-mono">{fmtInt(engine!.metrics?.warningCount)}</span></DetailRow>
                    <DetailRow label="Queue size"><span className="font-mono">{fmtInt(engine!.metrics?.queueSize)}</span></DetailRow>
                    <DetailRow label="Workload"><span className="font-mono">{engine!.metrics?.workload ?? 'N/A'}</span></DetailRow>
                    <DetailRow label="Last op duration"><span className="font-mono">{engine!.metrics?.lastOperationDurationMs ?? 'N/A'} ms</span></DetailRow>
                    <DetailRow label="Last op at"><span className="font-mono">{fmtEpoch(engine!.metrics?.lastOperationAt)}</span></DetailRow>
                  </div>
                  <div>
                    {customEntries.length === 0 && (
                      <p className="text-xs text-muted-foreground">No custom metrics exposed.</p>
                    )}
                    <div className="divide-y divide-border/50">
                      {customEntries.map(([k, v]) => (
                        <DetailRow key={k} label={k}>
                          <span className="max-w-[220px] truncate font-mono" title={fmtValue(v)}>{fmtValue(v)}</span>
                        </DetailRow>
                      ))}
                    </div>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="config">
              <AccordionTrigger className="text-sm">
                Config Summary
                <Badge variant="outline" className="ml-2 text-[10px]">{configEntries.length} keys</Badge>
              </AccordionTrigger>
              <AccordionContent>
                {configEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No config summary published by this engine.</p>
                ) : (
                  <div className="divide-y divide-border/50">
                    {configEntries.map(([k, v]) => (
                      <DetailRow key={k} label={k}>
                        <span className="max-w-[320px] truncate font-mono" title={fmtValue(v)}>{fmtValue(v)}</span>
                      </DetailRow>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="errors">
              <AccordionTrigger className="text-sm">
                Recent Errors
                <Badge variant="outline" className="ml-2 text-[10px]">{errorList.length} listed</Badge>
              </AccordionTrigger>
              <AccordionContent>
                {errorList.length === 0 ? (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-success" /> No errors recorded — clean.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {errorList.slice(0, 20).map((err, i) => (
                      <div key={i} className="rounded-md bg-destructive/5 px-2.5 py-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-medium text-destructive">{err.code || 'UNKNOWN'}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{fmtEpoch(err.timestamp)}</span>
                        </div>
                        {err.message && <p className="mt-0.5 text-muted-foreground">{err.message}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="activity">
              <AccordionTrigger className="text-sm">
                Recent Activity
                <Badge variant="outline" className="ml-2 text-[10px]">{activityList.length} events</Badge>
              </AccordionTrigger>
              <AccordionContent>
                {activityList.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No recent activity recorded by this engine yet.</p>
                ) : (
                  <div className="space-y-1">
                    {[...activityList].reverse().slice(0, 30).map((a, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-xs">
                        <span className="min-w-0">
                          <span className="mr-1.5 font-mono text-[10px] text-primary">{a.type || 'event'}</span>
                          <span className="text-muted-foreground">{a.message || '—'}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{fmtEpoch(a.timestamp)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </Card>
      </div>

      {/* Related engines + navigation */}
      <div>
        <h2 className="mb-3 flex items-center gap-1.5 text-lg font-semibold">
          <UserRound className="h-4 w-4 text-primary" /> Related Engines
          <span className="text-sm font-normal text-muted-foreground">· {engine!.engineCategory}</span>
        </h2>
        {related.length === 0 ? (
          <p className="text-xs text-muted-foreground">No other engines share this category.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((r) => {
              const RIcon = CATEGORY_ICONS[r.engineCategory] || Server;
              return (
                <Link key={r.engineId} href={engineProfileHref(r.engineId)}>
                  <Card className="shadow-soft transition-colors hover:border-primary/60">
                    <CardContent className="flex items-center gap-2.5 p-3">
                      <RIcon className={`h-4 w-4 shrink-0 ${CATEGORY_COLORS[r.engineCategory] ?? 'text-muted-foreground'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{r.engineName}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">{r.engineId}</span>
                      </span>
                      <Badge className={`${STATE_COLORS[r.state] || STATE_COLORS.UNKNOWN} shrink-0`}>{r.state}</Badge>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer navigation */}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button size="sm" variant="outline" asChild>
          <Link href="/services/system"><ArrowLeft className="mr-1 h-3 w-3" /> All engines</Link>
        </Button>
        {workspace && (
          <Button size="sm" variant="default" asChild>
            <Link href={workspace.href}><ExternalLink className="mr-1 h-3 w-3" /> Open {workspace.label} page</Link>
          </Button>
        )}
        <Button size="sm" variant="ghost" asChild className="ml-auto">
          <Link href="/services/system"><Server className="mr-1 h-3 w-3" /> Service Control Center</Link>
        </Button>
      </div>
    </div>
  );
}
