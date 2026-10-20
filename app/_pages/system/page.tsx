'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity, AlertCircle, ArrowUpRight, CheckCircle2, ChevronDown, ChevronRight,
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
  fmtValue, isRunningState, postEngineAction, usePoll,
  type BrokerOption, type BrokerStatus, type BrokerSwitchResult,
  type EngineStatus, type SystemSummary,
} from '@/lib/system-engines';
import { EngineSettingsPanel } from '@/components/engines/engine-settings-panel';
import { FleetStatusDonut } from './charts';

/**
 * SERVICES → System (Phase 3 Service Control Center)
 *
 * Full fleet page: summary cards, fleet chart cards, broker services, and one
 * rich card per registered engine. Every card carries a dropdown (⋮) menu plus
 * an expandable inline details section, and links out to the engine's full
 * profile/detail page at /services/system/[engineId].
 *
 * Real backend data only. Every value comes from the Engine Registry API.
 * Missing values render as N/A, never as invented data.
 */

const API = ENGINES_API;

type ActionResult = { ok: boolean; error?: string; requiresConfirmation?: boolean };

const HEALTH_RANK: Record<string, number> = {
  UNHEALTHY: 0, DEGRADED: 1, UNKNOWN: 2, HEALTHY: 3,
};

function QuickRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Engine card: full card + dropdown menu + expandable details + links */
/* ------------------------------------------------------------------ */

function EngineCard({
  engine,
  onAction,
}: {
  engine: EngineStatus;
  onAction: (id: string, action: string, confirm?: boolean) => Promise<ActionResult>;
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
    <Card className={`shadow-soft flex flex-col transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg hover:border-primary/25 ${expanded ? 'border-primary/40 ring-1 ring-primary/20' : ''}`}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2 gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? 'Collapse details' : 'Expand details'}
        >
          <Icon className={`h-4 w-4 shrink-0 ${CATEGORY_COLORS[engine.engineCategory] || 'text-muted-foreground'}`} />
          <span className="min-w-0">
            <CardTitle className="truncate text-sm font-medium">{engine.engineName}</CardTitle>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">{engine.engineId}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
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
            className="rounded p-1 text-muted-foreground hover:text-foreground"
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
          <span className="font-mono">{fmtInt(engine.metrics?.eventCount)}</span>
        </QuickRow>
        <QuickRow label="Errors">
          <span className={`font-mono ${(engine.metrics?.errorCount ?? 0) > 0 ? 'text-destructive' : ''}`}>
            {fmtInt(engine.metrics?.errorCount)}
          </span>
        </QuickRow>
        <QuickRow label="Heartbeat">
          <span className="font-mono">{fmtAgo(engine.heartbeatAge)}</span>
        </QuickRow>

        {expanded && (
          <div className="mt-2 space-y-2 border-t pt-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <QuickRow label="Version"><span className="font-mono">{engine.version || 'N/A'}</span></QuickRow>
              <QuickRow label="Category"><span>{engine.engineCategory || 'N/A'}</span></QuickRow>
              <QuickRow label="Warnings"><span className="font-mono">{fmtInt(engine.metrics?.warningCount)}</span></QuickRow>
              <QuickRow label="Queue"><span className="font-mono">{fmtInt(engine.metrics?.queueSize)}</span></QuickRow>
              <QuickRow label="Workload"><span className="font-mono">{engine.metrics?.workload ?? 'N/A'}{engine.metrics?.workload != null ? '%' : ''}</span></QuickRow>
              <QuickRow label="Last op"><span className="font-mono">{engine.metrics?.lastOperationDurationMs != null ? `${engine.metrics.lastOperationDurationMs}ms` : 'N/A'}</span></QuickRow>
              <QuickRow label="Started"><span className="font-mono">{fmtEpoch(engine.startedAt)}</span></QuickRow>
              <QuickRow label="Uptime"><span className="font-mono">{fmtAgo(engine.startedAtAgo)}</span></QuickRow>
              <QuickRow label="Connection"><span>{engine.connectionState || 'N/A'}</span></QuickRow>
            </div>

            {engine.dependencies.length > 0 && (
              <div>
                <span className="text-muted-foreground">Dependencies:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {engine.dependencies.map((d) => (
                    <Link key={d} href={engineProfileHref(d)}>
                      <Badge variant="outline" className="text-[10px] hover:border-primary hover:text-primary">{d}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {engine.dependents.length > 0 && (
              <div>
                <span className="text-muted-foreground">Dependents:</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {engine.dependents.map((d) => (
                    <Link key={d} href={engineProfileHref(d)}>
                      <Badge variant="outline" className="text-[10px] hover:border-primary hover:text-primary">{d}</Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {customEntries.length > 0 && (
              <div>
                <span className="text-muted-foreground">Custom metrics ({customEntries.length}):</span>
                <div className="mt-1 space-y-0.5">
                  {customEntries.slice(0, 5).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-2">
                      <span className="truncate font-mono text-[11px]">{k}</span>
                      <span className="font-mono text-[11px]">{fmtValue(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {configEntries.length > 0 && (
              <div>
                <span className="text-muted-foreground">Config ({configEntries.length}):</span>
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

            {/* The engine's real, writable settings — not a read-only mirror of
                the summary above. Rendered last so the fact list stays scannable
                and the editor is the explicit next step. */}
            <EngineSettingsPanel engineId={engine.engineId} engineName={engine.engineName} compact />
            {engine.recentErrors.length > 0 && (
              <div>
                <span className="text-muted-foreground">Recent errors:</span>
                <div className="mt-1 space-y-1">
                  {engine.recentErrors.slice(0, 3).map((err, i) => (
                    <div key={i} className="rounded bg-destructive/5 p-1 text-[10px] text-destructive">
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

/* ------------------------------------------------------------------ */
/* Broker card (unchanged behaviour, keeps trading/market-data switch) */
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
    <Card className="shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg hover:border-primary/25">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <span className="rounded-xl bg-primary/10 p-2">
            <Icon className="h-4 w-4 text-primary" />
          </span>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          {isImplemented && isConnected && (
            <span className="relative flex h-2 w-2" title="Live">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
          )}
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
              <div className="italic text-muted-foreground">
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
/* Main page                                                           */
/* ------------------------------------------------------------------ */

export default function SystemPage() {
  const { data: summary, error: summaryError, refresh: refreshSummary } = usePoll<SystemSummary>(`${API}/summary`, 10000);
  const { data: engines, error: enginesError, refresh: refreshEngines } = usePoll<EngineStatus[]>(`${API}`, 8000);
  const { data: tradingBroker, error: tradingError, refresh: refreshTrading } = usePoll<BrokerStatus>(`${API}/broker/trading`, 10000);
  const { data: marketDataBroker, error: marketDataError, refresh: refreshMarketData } = usePoll<BrokerStatus>(`${API}/broker/market-data`, 10000);
  const { data: brokers, refresh: refreshBrokers } = usePoll<BrokerOption[]>(`${API}/broker/list`, 30000);

  const [search, setSearch] = useState('');
  const [filterState, setFilterState] = useState('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [sortBy, setSortBy] = useState('name');
  const [brokerBusy, setBrokerBusy] = useState<'trading' | 'market-data' | null>(null);
  const [brokerResult, setBrokerResult] = useState<Partial<Record<'trading' | 'market-data', BrokerSwitchResult>>>({});
  const [fleetBusy, setFleetBusy] = useState<string | null>(null);
  const [fleetMsg, setFleetMsg] = useState<string | null>(null);

  const enginesList = Array.isArray(engines) ? engines : null;
  const hasPollErrors = [enginesError, summaryError, tradingError, marketDataError].some(Boolean);

  const refreshAll = useCallback(() => {
    refreshSummary();
    refreshEngines();
    refreshTrading();
    refreshMarketData();
    refreshBrokers();
  }, [refreshSummary, refreshEngines, refreshTrading, refreshMarketData, refreshBrokers]);

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
      refreshTrading();
      refreshMarketData();
    }
  }, [refreshTrading, refreshMarketData]);

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

  /** Donut split: chalu vs band vs attention — summary se, fallback live list se. */
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Service Control Center</h1>
          <p className="text-sm text-muted-foreground">
            {enginesList
              ? `${totalEngines} engines · ${summary?.healths?.HEALTHY || 0} healthy · ${summary?.healths?.DEGRADED || 0} degraded · ${summary?.healths?.UNHEALTHY || 0} unhealthy`
              : 'Loading engines…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={
            overallState === 'HEALTHY' ? 'bg-success/10 text-success' :
            overallState === 'DEGRADED' ? 'bg-warning/10 text-warning' :
            overallState === 'ERROR' ? 'bg-destructive/10 text-destructive' :
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
            <span className="relative flex h-2 w-2" title="Auto-refresh on">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Auto-refreshing
          </span>
          <Button size="sm" variant="ghost" onClick={refreshAll} title="Refresh now">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {fleetMsg && <p className="text-xs text-muted-foreground">{fleetMsg}</p>}

      {/* Diagnostics */}
      {hasPollErrors && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> One or more control-plane requests are failing
            </div>
            {[['engines', enginesError], ['summary', summaryError], ['trading broker', tradingError], ['market data', marketDataError]]
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="card-accent-green group shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total Engines</span>
              <span className="rounded-xl bg-primary/10 p-2 transition-transform duration-200 group-hover:scale-110">
                <Activity className="h-5 w-5 text-primary" />
              </span>
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{totalEngines}</div>
            <p className="text-xs text-muted-foreground">registered</p>
          </CardContent>
        </Card>
        <Card className="card-accent-teal group shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Running</span>
              <span className="rounded-xl bg-success/10 p-2 transition-transform duration-200 group-hover:scale-110">
                <CheckCircle2 className="h-5 w-5 text-success" />
              </span>
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">
              {(summary?.states?.RUNNING || 0) + (summary?.states?.HEALTHY || 0)}
            </div>
            <p className="text-xs text-muted-foreground">active engines</p>
          </CardContent>
        </Card>
        <Card className="card-accent-amber group shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Degraded</span>
              <span className="rounded-xl bg-warning/10 p-2 transition-transform duration-200 group-hover:scale-110">
                <AlertCircle className="h-5 w-5 text-warning" />
              </span>
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">
              {(summary?.healths?.DEGRADED || 0) + (summary?.healths?.UNHEALTHY || 0)}
            </div>
            <p className="text-xs text-muted-foreground">need attention</p>
          </CardContent>
        </Card>
        <Card className="card-accent-purple group shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">System Health</span>
              <span className="rounded-xl bg-purple-500/10 p-2 transition-transform duration-200 group-hover:scale-110">
                <Shield className={`h-5 w-5 ${overallState === 'HEALTHY' ? 'text-success' : 'text-warning'}`} />
              </span>
            </div>
            <div className="mt-1 text-2xl font-bold">{overallState}</div>
            <p className="text-xs text-muted-foreground">overall status</p>
          </CardContent>
        </Card>
      </div>

      {/* Status overview — single donut: kitne chalu, kitne band */}
      <Card className="shadow-soft transition-all duration-200 hover:shadow-soft-lg">
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
      <div>
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
        <div>
          <h2 className="mb-3 text-lg font-semibold">Engine Categories</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
            {Object.entries(categoryCounts).map(([cat, count]) => {
              const Icon = CATEGORY_ICONS[cat] || Activity;
              const active = filterCategory === cat;
              return (
                <button key={cat} type="button" onClick={() => setFilterCategory(active ? 'all' : cat)} title={active ? 'Clear category filter' : `Filter by ${cat}`}>
                  <Card className={`shadow-soft transition-all duration-200 hover:-translate-y-1 hover:shadow-soft-lg ${active ? 'border-primary ring-1 ring-primary/40' : 'hover:border-primary/50'}`}>
                    <CardContent className="p-3 text-center">
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
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search engines…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={filterState} onValueChange={setFilterState}>
          <SelectTrigger className="w-36"><SelectValue placeholder="State" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            {stateOptions.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterCategory} onValueChange={setFilterCategory}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.keys(categoryCounts).map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Sort by" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Sort: Name</SelectItem>
            <SelectItem value="health">Sort: Health (worst first)</SelectItem>
            <SelectItem value="events">Sort: Events (most first)</SelectItem>
            <SelectItem value="errors">Sort: Errors (most first)</SelectItem>
            <SelectItem value="heartbeat">Sort: Heartbeat (stalest first)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Engine Cards */}
      <div>
        <h2 className="mb-3 text-lg font-semibold">
          All Engines {enginesList && <span className="text-sm font-normal text-muted-foreground">({filteredEngines.length} of {enginesList.length})</span>}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {loadingEngines
            ? Array.from({ length: 8 }).map((_, i) => (
                <Card key={`skeleton-${i}`} className="shadow-soft">
                  <CardContent className="space-y-2 pt-6">
                    <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                  </CardContent>
                </Card>
              ))
            : filteredEngines.map((engine) => (
                <EngineCard key={engine.engineId} engine={engine} onAction={handleAction} />
              ))}
        </div>
      </div>

      {!enginesList && enginesError && (
        <div className="py-8 text-center text-muted-foreground">
          404 or unreachable — {enginesError}. Retrying automatically…
        </div>
      )}
      {!enginesList && !enginesError && (
        <div className="py-8 text-center text-muted-foreground">
          Loading engine list…
        </div>
      )}
      {enginesList && filteredEngines.length === 0 && (
        <div className="py-8 text-center text-muted-foreground">
          No engines match the current filters.
        </div>
      )}
    </div>
  );
}
