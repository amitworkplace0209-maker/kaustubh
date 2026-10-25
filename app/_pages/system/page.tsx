'use client';

import { useCallback, useEffect, useMemo, useState, memo } from 'react';
import Link from 'next/link';
import {
  Activity, AlertCircle, ArrowUpRight, ChevronDown, ChevronRight, CheckCircle2,
  Copy, ExternalLink, HeartPulse, MoreVertical, Play, RefreshCw, RotateCw,
  Search, Shield, ShoppingCart, Square, Stethoscope, UserRound, Wifi,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CATEGORY_COLORS, CATEGORY_ICONS, ENGINE_WORKSPACE_LINKS, ENGINES_API,
  HEALTH_COLORS, STATE_COLORS, engineProfileHref, fmtAgo, fmtEpoch, fmtInt,
  fmtValue, isRunningState, loadEnginesOverview, postEngineAction,
  type BrokerOption, type BrokerStatus, type BrokerSwitchResult,
  type EngineStatus, type EnginesDocument, type SystemSummary,
} from '@/lib/system-engines';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';
import { EngineSettingsPanel } from '@/components/engines/engine-settings-panel';
import { FleetStatusDonut } from './charts';

/**
 * SERVICES → System (Service Control Center)
 *
 * Redesigned fleet page: glassmorphism cards, staggered engine rendering
 * (one engine mounts line-by-line with a rising stagger), live WebSocket
 * indicators, ambient sweep background, and animated summary counters.
 *
 * Real backend data only. Every value comes from the Engine Registry API.
 * Missing values render as N/A, never as invented data.
 */

const API = ENGINES_API;

type ActionResult = { ok: boolean; error?: string; requiresConfirmation?: boolean };

const HEALTH_RANK: Record<string, number> = {
  UNHEALTHY: 0, DEGRADED: 1, UNKNOWN: 2, HEALTHY: 3,
};

const STATE_DOT: Record<string, { bg: string; ring: string }> = {
  RUNNING: { bg: 'bg-success', ring: 'ring-success/40' },
  HEALTHY: { bg: 'bg-success', ring: 'ring-success/40' },
  REGISTERED: { bg: 'bg-muted', ring: 'ring-muted/40' },
  STARTING: { bg: 'bg-warning', ring: 'ring-warning/40' },
  STOPPED: { bg: 'bg-muted', ring: 'ring-muted/40' },
  STOPPING: { bg: 'bg-warning', ring: 'ring-warning/40' },
  DEGRADED: { bg: 'bg-warning', ring: 'ring-warning/40' },
  ERROR: { bg: 'bg-destructive', ring: 'ring-destructive/40' },
  DISCONNECTED: { bg: 'bg-destructive', ring: 'ring-destructive/40' },
  STALE: { bg: 'bg-warning', ring: 'ring-warning/40' },
  DISABLED: { bg: 'bg-muted', ring: 'ring-muted/40' },
  DEPENDENCY_ERROR: { bg: 'bg-destructive', ring: 'ring-destructive/40' },
  RESTARTING: { bg: 'bg-info', ring: 'ring-info/40' },
  UNKNOWN: { bg: 'bg-muted', ring: 'ring-muted/40' },
};

/* ------------------------------------------------------------------ */
/* Live dot — pulses when the WebSocket is pushing fresh data         */
/* ------------------------------------------------------------------ */

function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      className={[
        'relative inline-flex h-2 w-2 rounded-full',
        live ? 'bg-success ring-2 ring-success/50 animate-pulse' : 'bg-warning ring-2 ring-warning/50',
      ].join(' ')}
      aria-label={live ? 'Live · WebSocket' : 'REST fallback'}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Animated counter                                                   */
/* ------------------------------------------------------------------ */

function AnimatedCounter({ value, label, color = 'text-foreground' }: { value: number; label: string; color?: string }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf: number;
    const start = performance.now();
    const from = display;
    const to = value;
    const dur = 700;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, display]);
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`font-mono font-bold tabular-nums ${color}`}>{display}</span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Glow pill — decorative ambient pill behind header badges           */
/* ------------------------------------------------------------------ */

function GlowPill({ color }: { color: string }) {
  return (
    <span
      className="absolute -inset-px blur-xl opacity-40 rounded-full"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

/* ------------------------------------------------------------------ */
/* QuickRow                                                           */
/* ------------------------------------------------------------------ */

function QuickRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Status dot                                                         */
/* ------------------------------------------------------------------ */

function StatusDot({ state }: { state: string }) {
  const style = STATE_DOT[state] ?? STATE_DOT.UNKNOWN;
  return (
    <span
      className={`inline-flex h-2 w-2 shrink-0 rounded-full ${style.bg} shadow`}
      style={{ boxShadow: `0 0 8px ${style.bg === 'bg-success' ? '#22c55e' : style.bg === 'bg-warning' ? '#f59e0b' : '#ef4444'}` }}
      aria-label={state}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Engine card: glassmorphism + staggered mount                       */
/* ------------------------------------------------------------------ */

function EngineCard({
  engine,
  onAction,
  index,
  className,
  style,
}: {
  engine: EngineStatus;
  onAction: (id: string, action: string, confirm?: boolean) => Promise<ActionResult>;
  index: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const Icon = CATEGORY_ICONS[engine.engineCategory] || Activity;
  const running = isRunningState(engine.state);
  const isError = ['ERROR', 'DEPENDENCY_ERROR'].includes(engine.state);
  const workspace = ENGINE_WORKSPACE_LINKS[engine.engineId];
  const customEntries = Object.entries(engine.metrics?.custom ?? {});
  const configEntries = Object.entries(engine.configSummary ?? {});

  const run = async (action: string, confirmed = false) => {
    setBusy(action);
    setMsg(null);
    const r = await onAction(engine.engineId, action, confirmed);
    setBusy(null);
    if (!r.ok && r.requiresConfirmation) {
      setNeedsConfirm(true);
      setMsg(r.error ?? 'Confirmation required');
    } else {
      setNeedsConfirm(false);
      setMsg(r.ok ? `${action} accepted` : (r.error ?? `${action} failed`));
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(engine.engineId);
      setMsg('engine id copied');
    } catch {
      setMsg('copy failed');
    }
  };

  return (
    <Card
      className={[
        'relative overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft',
        'transition-all duration-300',
        'hover:-translate-y-1 hover:shadow-soft-lg hover:border-primary/30',
        expanded ? 'border-primary/40 ring-1 ring-primary/20' : '',
        className,
      ].filter(Boolean).join(' ')}
      style={style}>
      <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 pointer-events-none" aria-hidden="true" />
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2 gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          <div className="relative shrink-0">
            <Icon className={`h-4 w-4 ${CATEGORY_COLORS[engine.engineCategory] || 'text-muted-foreground'}`} />
            <div
              className="absolute -inset-1 blur-md opacity-40 rounded-full"
              style={{ background: CATEGORY_COLORS[engine.engineCategory] || '#6b7280' }}
              aria-hidden="true"
            />
          </div>
          <span className="min-w-0">
            <CardTitle className="truncate text-sm font-medium">{engine.engineName}</CardTitle>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">{engine.engineId}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <StatusDot state={engine.state} />
            {running && (
              <span className="absolute -inset-1 animate-ping rounded-full bg-success opacity-60" aria-hidden="true" />
            )}
          </span>
          <Badge className={STATE_COLORS[engine.state] || STATE_COLORS.UNKNOWN}>
            {engine.state}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`${engine.engineName} menu`}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild>
                <Link href={engineProfileHref(engine.engineId)} className="flex items-center gap-2">
                  <UserRound className="h-3.5 w-3.5" /> View full profile
                </Link>
              </DropdownMenuItem>
              {workspace && (
                <DropdownMenuItem asChild>
                  <Link href={workspace.href} className="flex items-center gap-2">
                    <ExternalLink className="h-3.5 w-3.5" /> Open {workspace.label}
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setExpanded((v) => !v)}>
                {expanded ? (
                  <span className="flex items-center gap-2"><ChevronDown className="h-3.5 w-3.5" /> Collapse details</span>
                ) : (
                  <span className="flex items-center gap-2"><ChevronRight className="h-3.5 w-3.5" /> Expand details</span>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {!running && (
                <DropdownMenuItem onClick={() => run('start')} disabled={busy != null}>
                  <Play className="h-3.5 w-3.5" /> Start engine
                </DropdownMenuItem>
              )}
              {running && !isError && (
                <DropdownMenuItem onClick={() => run('stop')} disabled={busy != null}>
                  <Square className="h-3.5 w-3.5" /> Stop engine
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => run('restart')} disabled={busy != null}>
                <RotateCw className="h-3.5 w-3.5" /> Restart engine
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => run('heartbeat')} disabled={busy != null}>
                <Activity className="h-3.5 w-3.5" /> Send heartbeat
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={copyId}>
                <Copy className="h-3.5 w-3.5" /> Copy engine id
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col space-y-1 text-xs">
        <QuickRow label="Health">
          <Badge variant="outline" className={HEALTH_COLORS[engine.health] || 'text-muted-foreground'}>
            {engine.health || 'N/A'}
          </Badge>
        </QuickRow>
        {engine.healthReason ? (
          <QuickRow label="Reason">
            <span className="block max-w-[220px] truncate text-muted-foreground" title={engine.healthReason}>
              {engine.healthReason}
            </span>
          </QuickRow>
        ) : null}
        <QuickRow label="Events">
          <span className="font-mono text-success">{fmtInt(engine.metrics?.eventCount)}</span>
        </QuickRow>
        <QuickRow label="Errors">
          <span className={`font-mono ${(engine.metrics?.errorCount ?? 0) > 0 ? 'text-destructive' : 'text-success'}`}>
            {fmtInt(engine.metrics?.errorCount)}
          </span>
        </QuickRow>
        <QuickRow label="Heartbeat">
          <span className="font-mono">{fmtAgo(engine.heartbeatAge)}</span>
        </QuickRow>

        {expanded && (
          <div className="mt-2 space-y-2 border-t border-border/40 pt-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <QuickRow label="Version"><span className="font-mono">{engine.version || 'N/A'}</span></QuickRow>
              <QuickRow label="Category"><span className="capitalize text-[11px]">{engine.engineCategory || 'N/A'}</span></QuickRow>
              <QuickRow label="Warnings"><span className="font-mono">{fmtInt(engine.metrics?.warningCount)}</span></QuickRow>
              <QuickRow label="Queue"><span className="font-mono">{fmtInt(engine.metrics?.queueSize)}</span></QuickRow>
              <QuickRow label="Workload"><span className="font-mono">{engine.metrics?.workload ?? 'N/A'}{engine.metrics?.workload != null ? '%' : ''}</span></QuickRow>
              <QuickRow label="Last op"><span className="font-mono">{engine.metrics?.lastOperationDurationMs != null ? `${engine.metrics.lastOperationDurationMs}ms` : 'N/A'}</span></QuickRow>
              <QuickRow label="Started"><span className="font-mono">{fmtEpoch(engine.startedAt)}</span></QuickRow>
              <QuickRow label="Uptime"><span className="font-mono">{fmtAgo(engine.startedAtAgo)}</span></QuickRow>
              <QuickRow label="Connection"><span className="capitalize text-[11px]">{engine.connectionState || 'N/A'}</span></QuickRow>
            </div>

            {engine.dependencies.length > 0 && (
              <div>
                <span className="text-muted-foreground text-[10px]">Dependencies:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {engine.dependencies.map((d) => (
                    <Link key={d} href={engineProfileHref(d)}>
                      <Badge variant="outline" className="text-[10px] hover:border-primary hover:text-primary transition-colors">{d}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {engine.dependents.length > 0 && (
              <div>
                <span className="text-muted-foreground text-[10px]">Dependents:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {engine.dependents.map((d) => (
                    <Link key={d} href={engineProfileHref(d)}>
                      <Badge variant="outline" className="text-[10px] hover:border-primary hover:text-primary transition-colors">{d}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {customEntries.length > 0 && (
              <div>
                <span className="text-muted-foreground text-[10px]">Custom metrics ({customEntries.length}):</span>
                <div className="mt-1 space-y-0.5">
                  {customEntries.slice(0, 5).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="truncate font-mono text-[11px]">{k}</span>
                      <span className="font-mono text-[11px] text-success">{fmtValue(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {configEntries.length > 0 && (
              <div>
                <span className="text-muted-foreground text-[10px]">Config ({configEntries.length}):</span>
                <div className="mt-1 space-y-0.5">
                  {configEntries.slice(0, 5).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="truncate font-mono text-[11px]">{k}</span>
                      <span className="max-w-[140px] truncate font-mono text-[11px]" title={fmtValue(v)}>{fmtValue(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <EngineSettingsPanel engineId={engine.engineId} engineName={engine.engineName} compact />
            {engine.recentErrors.length > 0 && (
              <div>
                <span className="text-muted-foreground text-[10px]">Recent errors:</span>
                <div className="mt-1 space-y-1">
                  {engine.recentErrors.slice(0, 3).map((err, i) => (
                    <div key={i} className="rounded bg-destructive/5 p-1 border border-destructive/20 text-[10px] text-destructive">
                      {err.code}: {err.message?.slice(0, 80)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
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
                  {busy === 'stop' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <AlertCircle className="mr-1 h-3 w-3" />} Confirm stop
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run('restart')}>
                {busy === 'restart' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <RotateCw className="mr-1 h-3 w-3" />} Restart
              </Button>
              <Button size="sm" variant="outline" disabled={busy != null} onClick={() => run('heartbeat')}>
                <HeartPulse className="mr-1 h-3 w-3" /> Heartbeat
              </Button>
            </div>
            {msg && (
              <p className={`text-[11px] ${msg.includes('accepted') || msg.includes('copied') ? 'text-success' : 'text-muted-foreground'}`}>{msg}</p>
            )}
          </div>
        )}

        <div className="mt-auto flex gap-2 pt-3">
          <Button size="sm" variant="default" className="flex-1" asChild>
            <Link href={engineProfileHref(engine.engineId)}>
              <UserRound className="mr-1 h-3 w-3" /> Full Profile
            </Link>
          </Button>
          {workspace && (
            <Button size="sm" variant="outline" className="flex-1" asChild>
              <Link href={workspace.href}>
                <ArrowUpRight className="mr-1 h-3 w-3" /> {workspace.label}
              </Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* Memoize so only the changed card re-renders on live ticks. */
const MemoEngineCard = memo(EngineCard);

/* ------------------------------------------------------------------ */
/* Broker card                                                        */
/* ------------------------------------------------------------------ */

function BrokerCard({
  title, status, brokers, kind, onSelect, busy, result, icon: Icon,
}: {
  title: string;
  status: BrokerStatus | null;
  brokers: BrokerOption[];
  kind: 'trading' | 'market-data';
  onSelect: (kind: 'trading' | 'market-data', brokerId: string) => void;
  busy: boolean;
  result: BrokerSwitchResult | null;
  icon: React.ElementType;
}) {
  const isImplemented = status?.implemented;
  const isConnected = status?.state === 'CONNECTED';
  const currentId = status?.broker ?? '';
  const options = kind === 'trading'
    ? brokers.map((b) => ({ ...b, implemented: !!b.capabilities?.trading }))
    : brokers.map((b) => ({ ...b, implemented: !!b.capabilities?.marketData }));

  return (
    <Card className="relative overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft transition-all duration-300 hover:-translate-y-0.5 hover:shadow-soft-lg hover:border-primary/25">
      <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 pointer-events-none" aria-hidden="true" />
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <span className="relative rounded-xl bg-primary/10 p-2">
            <Icon className="h-4 w-4 text-primary" />
            {isConnected && (
              <span className="absolute -right-1 -bottom-1 flex h-2 w-2">
                <span className="relative inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" aria-hidden="true" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" aria-hidden="true" />
              </span>
            )}
          </span>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </div>
        {status && (
          <Badge className={
            !isImplemented ? 'bg-muted text-muted-foreground' :
            isConnected ? 'bg-success/10 text-success border-success/20' :
            'bg-destructive/10 text-destructive border-destructive/20'
          }>
            {!isImplemented ? 'NOT IMPLEMENTED' : status.state}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-xs">
        {status && (
          <>
            <QuickRow label="Broker"><span className="font-medium">{status.displayName}</span></QuickRow>
            {!isImplemented ? (
              <div className="italic text-muted-foreground text-[11px]">
                {status.message || `${status.displayName} adapter is not implemented yet`}
              </div>
            ) : (
              <>
                {status.sessionActive !== undefined && (
                  <QuickRow label="Session">
                    <span className={status.sessionActive ? 'text-success' : 'text-destructive'}>
                      {status.sessionActive ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </QuickRow>
                )}
                {status.subscribedSymbols !== undefined && (
                  <QuickRow label="Subscriptions"><span className="font-mono">{fmtInt(status.subscribedSymbols)}</span></QuickRow>
                )}
                {status.ticksPerSecond !== undefined && (
                  <QuickRow label="Ticks/sec"><span className="font-mono">{fmtInt(status.ticksPerSecond)}</span></QuickRow>
                )}
                {status.reconnectCount !== undefined && (
                  <QuickRow label="Reconnects"><span className="font-mono">{fmtInt(status.reconnectCount)}</span></QuickRow>
                )}
                {status.latencyMs !== undefined && status.latencyMs !== null && (
                  <QuickRow label="Latency"><span className="font-mono">{Math.round(status.latencyMs)}ms</span></QuickRow>
                )}
              </>
            )}
          </>
        )}
        <div className="flex items-center gap-2 pt-2">
          <Select
            value={options.some((o) => o.id === currentId) ? currentId : ''}
            onValueChange={(val) => val && onSelect(kind, val)}
            disabled={busy || options.length === 0}
          >
            <SelectTrigger className="h-8 w-full text-xs" aria-label={`Switch ${title}`}>
              <SelectValue placeholder="Select broker…" />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id} disabled={!o.implemented}>
                  {o.name}{o.implemented ? '' : ' (NOT IMPLEMENTED)'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {busy && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" /> Switching broker…
          </div>
        )}
        {!busy && result && (
          <div className={result.ok ? 'text-[10px] text-success' : 'text-[10px] text-destructive'}>
            {result.ok ? `Switched → ${result.current ?? ''}` : result.error || 'Switch failed'}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                          */
/* ------------------------------------------------------------------ */

export default function SystemPage() {
  const {
    data: controlPlane,
    live,
    error: liveError,
    refresh: refreshControlPlane,
  } = useRealtimeChannel<EnginesDocument>('engines', {
    fallback: loadEnginesOverview,
    fallbackKey: 'engines-overview',
    fallbackMs: 20000,
  });

  const engines: EngineStatus[] | null = useMemo(
    () => (controlPlane ? Object.values(controlPlane.engines ?? {}) : null),
    [controlPlane],
  );
  const summary: SystemSummary | null = controlPlane?.summary ?? null;
  const tradingBroker: BrokerStatus | null = controlPlane?.brokers?.trading ?? null;
  const marketDataBroker: BrokerStatus | null = controlPlane?.brokers?.marketData ?? null;
  const brokers: BrokerOption[] | null = controlPlane?.brokers?.list ?? null;

  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [sortBy, setSortBy] = useState('name');
  const [brokerBusy, setBrokerBusy] = useState<'trading' | 'market-data' | null>(null);
  const [brokerResult, setBrokerResult] = useState<Partial<Record<'trading' | 'market-data', BrokerSwitchResult>>>({});
  const [fleetBusy, setFleetBusy] = useState<string | null>(null);
  const [fleetMsg, setFleetMsg] = useState<string | null>(null);

  const enginesList = engines;
  const hasPollErrors = !enginesList && !!liveError;

  const refreshAll = useCallback(() => {
    refreshControlPlane();
  }, [refreshControlPlane]);

  const handleAction = useCallback(async (engineId: string, action: string, confirm = false): Promise<ActionResult> => {
    const r = await postEngineAction(
      `${API}/${engineId}/${action}`,
      action === 'stop' ? { confirm } : undefined,
    );
    setTimeout(refreshAll, 600);
    return r;
  }, [refreshAll]);

  const handleBrokerSelect = useCallback(async (kind: 'trading' | 'market-data', brokerId: string) => {
    setBrokerBusy(kind);
    setBrokerResult((prev) => ({ ...prev, [kind]: undefined }));
    try {
      const result = await postEngineAction(`${API}/broker/${kind}/select`, { broker: brokerId });
      setBrokerResult((prev) => ({ ...prev, [kind]: result }));
    } finally {
      setBrokerBusy(null);
      setTimeout(refreshAll, 600);
    }
  }, [refreshAll]);

  const handleFleetAction = useCallback(async (action: 'health-check' | 'heartbeat-all') => {
    setFleetBusy(action);
    setFleetMsg(null);
    const r = await postEngineAction(`${API}/${action}`);
    setFleetBusy(null);
    setFleetMsg(r.ok ? `${action} accepted` : (r.error ?? `${action} failed`));
    setTimeout(refreshAll, 600);
  }, [refreshAll]);

  const filteredEngines = useMemo(() => {
    if (!enginesList) return [];
    let list = [...enginesList];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((e) =>
        e.engineName.toLowerCase().includes(q) ||
        e.engineId.toLowerCase().includes(q) ||
        e.engineCategory.toLowerCase().includes(q),
      );
    }
    if (filterState !== 'all') list = list.filter((e) => e.state === filterState);
    if (filterCategory !== 'all') list = list.filter((e) => e.engineCategory === filterCategory);
    switch (sortBy) {
      case 'events':
        list.sort((a, b) => (b.metrics?.eventCount ?? 0) - (a.metrics?.eventCount ?? 0));
        break;
      case 'errors':
        list.sort((a, b) => (b.metrics?.errorCount ?? 0) - (a.metrics?.errorCount ?? 0));
        break;
      case 'heartbeat':
        list.sort((a, b) => (b.heartbeatAge ?? -1) - (a.heartbeatAge ?? -1));
        break;
      case 'health':
        list.sort((a, b) => (HEALTH_RANK[a.health] ?? 9) - (HEALTH_RANK[b.health] ?? 9));
        break;
      default:
        list.sort((a, b) => a.engineName.localeCompare(b.engineName));
    }
    return list;
  }, [enginesList, search, filterState, filterCategory, sortBy]);

  const categoryCounts = useMemo(() => {
    if (!enginesList) return {};
    const counts: Record<string, number> = {};
    for (const e of enginesList) {
      counts[e.engineCategory] = (counts[e.engineCategory] || 0) + 1;
    }
    return counts;
  }, [enginesList]);

  const stateOptions = useMemo(() => {
    const s = new Set<string>();
    for (const e of enginesList ?? []) s.add(e.state);
    return [...s].sort();
  }, [enginesList]);

  const statusSplit = useMemo(() => {
    const counts: Record<string, number> = { ...(summary?.states ?? {}) };
    if (!summary && enginesList) {
      for (const e of enginesList) counts[e.state] = (counts[e.state] || 0) + 1;
    }
    let running = 0, stopped = 0, attention = 0;
    for (const [s, c] of Object.entries(counts)) {
      if (s === 'RUNNING' || s === 'HEALTHY') running += c;
      else if (s === 'STOPPED' || s === 'REGISTERED' || s === 'DISABLED') stopped += c;
      else attention += c;
    }
    return { running, stopped, attention, total: running + stopped + attention };
  }, [summary, enginesList]);

  const overallState = summary?.overall || 'UNKNOWN';
  const totalEngines = summary?.total || enginesList?.length || 0;
  const loadingEngines = enginesList == null;

  return (
    <div className="space-y-0">
      {/* Ambient background sweep + measurement grid */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="si-sweep" aria-hidden="true" />
        <div className="si-grid inset-0" />
      </div>

      {/* Header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 pt-6 pb-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="relative rounded-xl bg-primary/10 p-2">
              <Activity className="h-5 w-5 text-primary" />
              <span className={`absolute -right-1 -bottom-1 h-2 w-2 rounded-full ${live ? 'animate-pulse bg-success ring-2 ring-success/50' : 'animate-pulse bg-warning ring-2 ring-warning/50'}`} />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Service Control Center</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {enginesList
              ? `${totalEngines} engines · ${summary?.healths?.HEALTHY || 0} healthy · ${summary?.healths?.DEGRADED || 0} degraded · ${summary?.healths?.UNHEALTHY || 0} unhealthy`
              : 'Loading engines…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={
            overallState === 'HEALTHY' ? 'bg-success/10 text-success border-success/20' :
            overallState === 'DEGRADED' ? 'bg-warning/10 text-warning border-warning/20' :
            overallState === 'ERROR' ? 'bg-destructive/10 text-destructive border-destructive/20' :
            'bg-muted text-muted-foreground'
          }>
            {overallState}
          </Badge>
          <Button size="sm" variant="outline" disabled={fleetBusy != null} onClick={() => handleFleetAction('health-check')}>
            {fleetBusy === 'health-check' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Stethoscope className="mr-1 h-3 w-3" />}
            Health check
          </Button>
          <Button size="sm" variant="outline" disabled={fleetBusy != null} onClick={() => handleFleetAction('heartbeat-all')}>
            {fleetBusy === 'heartbeat-all' ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <HeartPulse className="mr-1 h-3 w-3" />}
            Heartbeat all
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LiveDot live={live} />
            {live ? 'Live · WebSocket' : 'REST fallback'}
          </span>
          <Button size="sm" variant="ghost" onClick={refreshAll} title="Refresh now">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {fleetMsg && <p className="relative z-10 text-xs text-muted-foreground">{fleetMsg}</p>}

      {/* Diagnostics */}
      {hasPollErrors && (
        <div className="relative z-10 flex items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-xs">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> Control plane requests failing
            </div>
            {[['control plane', liveError]]
              .filter(([, e]) => !!e)
              .map(([name, e]) => (
                <div key={name as string} className="truncate text-muted-foreground">
                  <span className="font-mono">{name}</span>: {e}
                </div>
              ))}
          </div>
          <Button size="sm" variant="outline" onClick={refreshAll} className="shrink-0">
            <RefreshCw className="mr-1 h-3 w-3" /> Retry now
          </Button>
        </div>
      )}

      {/* Summary cards */}
      <div className="relative z-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="relative overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft group transition-all duration-300 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Engines</span>
              <div className="relative rounded-xl bg-primary/10 p-2 transition-transform duration-300 group-hover:scale-110">
                <Activity className="h-5 w-5 text-primary" />
                <GlowPill color="#3b82f6" />
              </div>
            </div>
            <AnimatedCounter value={totalEngines} label="registered" />
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft group transition-all duration-300 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Running</span>
              <div className="relative rounded-xl bg-success/10 p-2 transition-transform duration-300 group-hover:scale-110">
                <CheckCircle2 className="h-5 w-5 text-success" />
                <GlowPill color="#22c55e" />
              </div>
            </div>
            <AnimatedCounter value={(summary?.states?.RUNNING || 0) + (summary?.states?.HEALTHY || 0)} label="active engines" color="text-success" />
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft group transition-all duration-300 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Needs attention</span>
              <div className="relative rounded-xl bg-warning/10 p-2 transition-transform duration-300 group-hover:scale-110">
                <AlertCircle className="h-5 w-5 text-warning" />
                <GlowPill color="#f59e0b" />
              </div>
            </div>
            <AnimatedCounter value={(summary?.healths?.DEGRADED || 0) + (summary?.healths?.UNHEALTHY || 0)} label="degraded / unhealthy" color="text-warning" />
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft group transition-all duration-300 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">System health</span>
              <div className="relative rounded-xl bg-purple-500/10 p-2 transition-transform duration-300 group-hover:scale-110">
                <Shield className={`h-5 w-5 ${overallState === 'HEALTHY' ? 'text-success' : 'text-warning'}`} />
                <GlowPill color="#a855f7" />
              </div>
            </div>
            <AnimatedCounter value={0} label="overall status" color={overallState === 'HEALTHY' ? 'text-success' : 'text-warning'} />
            <div className="mt-1 text-xs font-medium capitalize">{overallState}</div>
          </CardContent>
        </Card>
      </div>

      {/* Status overview — single donut */}
      <Card className="relative z-10 overflow-hidden border-border/60 bg-card/60 backdrop-blur-md shadow-soft transition-all duration-300 hover:shadow-soft-lg">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100 pointer-events-none" aria-hidden="true" />
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
          <div>
            <CardTitle className="text-sm font-medium">Engine Status Overview</CardTitle>
            <p className="text-[11px] text-muted-foreground">Kitne engine chalu hain, kitne band — live registry se</p>
          </div>
          <Badge className={
            overallState === 'HEALTHY' ? 'bg-success/10 text-success' :
            overallState === 'DEGRADED' ? 'bg-warning/10 text-warning' :
            overallState === 'ERROR' ? 'bg-destructive/10 text-destructive' :
            'bg-muted text-muted-foreground'
          }>
            {overallState}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid items-center gap-4 md:grid-cols-5">
            <div className="md:col-span-2">
              <FleetStatusDonut running={statusSplit.running} stopped={statusSplit.stopped} attention={statusSplit.attention} />
            </div>
            <div className="space-y-3 md:col-span-3">
              {[
                { key: 'running', label: 'Chalu · Running', value: statusSplit.running, color: '#22c55e', bg: 'bg-success' },
                { key: 'stopped', label: 'Band · Stopped', value: statusSplit.stopped, color: '#6b7280', bg: 'bg-muted-foreground' },
                { key: 'attention', label: 'Dhyan do · Needs attention', value: statusSplit.attention, color: '#f59e0b', bg: 'bg-warning' },
              ].map((row) => {
                const pct = statusSplit.total > 0 ? Math.round((row.value / statusSplit.total) * 100) : 0;
                return (
                  <div key={row.key} className="rounded-lg border border-border/50 px-3 py-2 transition-colors hover:border-primary/40">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2 font-medium">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
                        {row.label}
                      </span>
                      <span className="font-mono font-bold tabular-nums">
                        {row.value}
                        <span className="ml-1.5 font-normal text-muted-foreground">{pct}%</span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${row.bg} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              <p className="text-[11px] text-muted-foreground">
                Running = RUNNING / HEALTHY · Stopped = STOPPED / REGISTERED / DISABLED · Baaki transitional ya error states attention me.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Broker Services */}
      <div className="relative z-10">
        <h2 className="mb-3 text-lg font-semibold">Broker Services</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <BrokerCard
            title="Trading Broker"
            status={tradingBroker}
            brokers={brokers ?? []}
            kind="trading"
            onSelect={handleBrokerSelect}
            busy={brokerBusy === 'trading'}
            result={brokerResult.trading ?? null}
            icon={ShoppingCart}
          />
          <BrokerCard
            title="Market Data Broker"
            status={marketDataBroker}
            brokers={brokers ?? []}
            kind="market-data"
            onSelect={handleBrokerSelect}
            busy={brokerBusy === 'market-data'}
            result={brokerResult['market-data'] ?? null}
            icon={Wifi}
          />
        </div>
      </div>

      {/* Engine Categories */}
      {enginesList && (
        <div className="relative z-10">
          <h2 className="mb-3 text-lg font-semibold">Engine Categories</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
            {Object.entries(categoryCounts).map(([cat, count]) => {
              const Icon = CATEGORY_ICONS[cat] || Activity;
              const active = filterCategory === cat;
              return (
                <button key={cat} type="button" onClick={() => setFilterCategory(active ? 'all' : cat)} title={active ? 'Clear category filter' : `Filter by ${cat}`}>
                  <Card className={`relative overflow-hidden shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-soft-lg ${active ? 'border-primary ring-1 ring-primary/40' : 'hover:border-primary/50'}`}>
                    <div className="absolute inset-0 bg-gradient-to-b from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" aria-hidden="true" />
                    <CardContent className="p-3 text-center relative z-10">
                      <Icon className={`mx-auto mb-1 h-5 w-5 ${CATEGORY_COLORS[cat]}`} />
                      <div className="text-lg font-bold">{count}</div>
                      <div className="text-[10px] uppercase text-muted-foreground">{cat}</div>
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="relative z-10 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <div className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none">
            <Search />
          </div>
          <Input
            placeholder="Search engines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-card/50 border-border/60"
          />
        </div>
        <Select value={filterState} onValueChange={setFilterState}>
          <SelectTrigger className="w-36 bg-card/50 border-border/60"><SelectValue placeholder="State" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            {stateOptions.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterCategory} onValueChange={setFilterCategory}>
          <SelectTrigger className="w-40 bg-card/50 border-border/60"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.keys(categoryCounts).map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-44 bg-card/50 border-border/60"><SelectValue placeholder="Sort by" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Sort: Name</SelectItem>
            <SelectItem value="health">Sort: Health (worst first)</SelectItem>
            <SelectItem value="events">Sort: Events (most first)</SelectItem>
            <SelectItem value="errors">Sort: Errors (most first)</SelectItem>
            <SelectItem value="heartbeat">Sort: Heartbeat (stalest first)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Engine Cards — rendered one at a time with a staggered rise */}
      <div className="relative z-10">
        <h2 className="mb-3 text-lg font-semibold">
          All Engines {enginesList && <span className="text-sm font-normal text-muted-foreground">({filteredEngines.length} of {enginesList.length})</span>}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {loadingEngines
            ? Array.from({ length: 8 }).map((_, i) => (
                <Card key={`skeleton-${i}`} className="shadow-soft border-border/60 bg-card/60 backdrop-blur-md">
                  <CardContent className="space-y-2 pt-6">
                    <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                  </CardContent>
                </Card>
              ))
            : filteredEngines.map((engine, i) => (
                <MemoEngineCard
                  key={engine.engineId}
                  engine={engine}
                  onAction={handleAction}
                  index={i}
                  className="ds-rise"
                  style={{ '--ds-i': String(i) } as React.CSSProperties}
                />
              ))}
        </div>
      </div>

      {!enginesList && liveError && (
        <div className="relative z-10 py-8 text-center text-muted-foreground">
          404 or unreachable — {liveError}. Retrying automatically…
        </div>
      )}
      {!enginesList && !liveError && (
        <div className="relative z-10 py-8 text-center text-muted-foreground">
          Loading engine list…
        </div>
      )}
      {enginesList && filteredEngines.length === 0 && (
        <div className="relative z-10 py-8 text-center text-muted-foreground">
          No engines match the current filters.
        </div>
      )}
    </div>
  );
}
