'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  AlertOctagon,
  AlertTriangle,
  Blocks,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Database,
  Search,
  Settings,
  Trash2,
  WifiOff,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  PageHeader, SectionCard, SectionHeading, StatusBadge, EmptyState, LoadingState,
} from '@/components/design-system';
import { fmtTimestampIST, fmtUptime } from '@/lib/formatters';
import { useRealtime } from '@/components/realtime-provider';
import {
  getAlerts, getAlertSummary,
  acknowledgeAlert, resolveAlert, deleteAlert,
  deleteAlertsMany, deleteAllAlerts,
  buildQuery,
} from '@/lib/api';

interface AlertItem {
  _id: string;
  alert_id?: string;
  rule_id?: string;
  category?: string;
  severity?: string;
  title?: string;
  message?: string;
  status?: 'active' | 'acknowledged' | 'resolved';
  acknowledged?: boolean;
  resolved?: boolean;
  symbol?: string;
  token?: string;
  exchange?: string;
  source?: string;
  component?: string;
  reason?: string;
  reason_code?: string;
  occurrence_count?: number;
  duration_ms?: number;
  triggered_at?: string;
  event_timestamp?: string;
  created_at?: string;
  updated_at?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  resolved_at?: string;
  resolved_reason?: string;
  expires_at?: string;
  related_event_id?: string;
  related_notification_id?: string;
  deduplication_key?: string;
  metadata?: Record<string, unknown>;
  automation?: {
    dedupe?: boolean;
    dedupeWindow?: number;
    cooldownSeconds?: number;
    autoResolveOn?: string | null;
    ruleId?: string;
  };
}

interface AlertsResponse {
  alerts: AlertItem[];
  total: number;
  activeCount: number;
  unreadCount: number;
  live?: boolean;
  retentionHours?: number;
}

interface Summary {
  total: number;
  active: number;
  open: number;
  acknowledged: number;
  resolved: number;
  critical: number;
  warning: number;
  today: number;
  lastAlertAt?: string | null;
  byCategory?: Record<string, number>;
  live?: boolean;
  retentionHours?: number;
}

const PAGE_SIZE = 20;
const LIVE_WINDOW_MS = 10 * 60 * 1000;

const SEV_META: Record<string, { icon: React.ElementType; cls: string; chip: string }> = {
  info: { icon: Activity, cls: 'text-info', chip: 'text-info border-info/30 bg-info/10' },
  success: { icon: CheckCircle2, cls: 'text-success', chip: 'text-success border-success/30 bg-success/10' },
  warning: { icon: AlertTriangle, cls: 'text-warning', chip: 'text-warning border-warning/30 bg-warning/10' },
  error: { icon: AlertOctagon, cls: 'text-destructive', chip: 'text-destructive border-destructive/30 bg-destructive/10' },
  critical: { icon: AlertOctagon, cls: 'text-destructive', chip: 'text-destructive border-destructive/30 bg-destructive/10' },
};

const STATUS_META: Record<string, { label: string; badge: 'success' | 'info' | 'warning' | 'danger' }> = {
  active: { label: 'Active', badge: 'danger' },
  acknowledged: { label: 'Acknowledged', badge: 'info' },
  resolved: { label: 'Resolved', badge: 'success' },
};

const CANONICAL_ORDER = [
  'WEBSOCKET', 'DATABASE', 'MARKET', 'TICKS', 'PIPELINE',
  'SCHEDULER', 'DOWNLOADS', 'EXPORTS', 'DATA_QUALITY', 'SESSION', 'SYSTEM',
];

function rel(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 15_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/**
 * Engine id behind an engine self-reported alert, or null for any other source.
 * The reporter writes `component = "engine:<id>"`; nothing else uses that shape.
 */
function engineIdOf(a: AlertItem): string | null {
  const c = a.component ?? '';
  if (!c.startsWith('engine:')) return null;
  const id = c.slice('engine:'.length).trim();
  return id || null;
}

function durationOf(a: AlertItem): string | null {  if (typeof a.duration_ms === 'number' && a.duration_ms >= 0) return fmtUptime(Math.floor(a.duration_ms / 1000));
  const startRaw = a.created_at || a.first_seen_at;
  if (a.resolved_at && startRaw) {
    const start = new Date(startRaw).getTime();
    const end = new Date(a.resolved_at).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return fmtUptime(Math.floor((end - start) / 1000));
    }
  }
  return null;
}

function kv(cols: number, rows: Array<[string, React.ReactNode]>): React.ReactNode {
  return (
    <div className={cn('grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2', cols === 3 && 'lg:grid-cols-3')}>
      {rows.map(([k, v], i) => (
        <div key={i} className="flex flex-col min-w-0">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{k}</span>
          <span className="truncate text-xs text-foreground/90">{v ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

export default function Phase2AlertsPage() {
  const { notifEpoch, subscribeToNotificationEvents } = useRealtime();
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [offline, setOffline] = useState(false);
  const [lastGoodAt, setLastGoodAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [categoryFilter, setCategoryFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | { kind: 'single'; id: string } | { kind: 'selected' } | { kind: 'all' }>(null);
  const [busy, setBusy] = useState(false);

  const filtersRef = useRef({ categoryFilter, severityFilter, statusFilter, search, page });
  filtersRef.current = { categoryFilter, severityFilter, statusFilter, search, page };
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lightweight clock: re-render the relative labels occasionally.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const queryParams = useCallback((
    f: typeof filtersRef.current = filtersRef.current,
  ) => buildQuery({
    limit: PAGE_SIZE,
    offset: f.page * PAGE_SIZE,
    sort: 'created_at',
    status: f.statusFilter || '',
    severity: f.severityFilter || '',
    category: f.categoryFilter || '',
    search: f.search.trim() || '',
  }), []);

  const fetchData = useCallback(async () => {
    let res: AlertsResponse;
    try {
      res = await getAlerts(queryParams()) as AlertsResponse;
    } catch {
      setOffline(true);
      setLoading(false);
      return;
    }
    setOffline(false);
    setLastGoodAt(Date.now());
    setAlerts(res?.alerts ?? []);
    setTotal(res?.total ?? 0);
    setLoading(false);
  }, [queryParams]);

  const fetchSummary = useCallback(async () => {
    try {
      const s = await getAlertSummary() as Summary;
      setSummary(s);
      setOffline(false);
      setLastGoodAt(Date.now());
    } catch {
      // keep the previous summary; offline banner is driven by fetchData
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void fetchData();
    void fetchSummary();
  }, [fetchData, fetchSummary]);

  // Debounced re-sync scheduled after realtime frames, so bursts of frames
  // never spam the API while the local merge already keeps the list live.
  const scheduleResync = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void fetchData();
      void fetchSummary();
    }, 450);
  }, [fetchData, fetchSummary]);

  const passesFilters = useCallback((a: AlertItem) => {
    const f = filtersRef.current;
    if (f.categoryFilter && a.category !== f.categoryFilter) return false;
    if (f.severityFilter && a.severity !== f.severityFilter) return false;
    if (f.statusFilter && (a.status ?? 'active') !== f.statusFilter) return false;
    if (f.search.trim()) {
      const q = f.search.trim().toLowerCase();
      const hay = [a.title, a.message, a.reason, a.reason_code, a.symbol, a.rule_id, a.component]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }, []);

  useEffect(() => {
    return subscribeToNotificationEvents((frame) => {
      const type = String(frame.type ?? '');
      if (type === 'alert_created' || type === 'alert_updated') {
        const al = (frame.alert as AlertItem | undefined) ?? null;
        if (al?._id) {
          setAlerts((prev) => {
            const exists = prev.some((x) => x._id === al._id);
            if (!exists && !passesFilters(al)) return prev;
            const next = exists
              ? prev.map((x) => (x._id === al._id ? { ...x, ...al } : x))
              : [al, ...prev];
            return next.slice(0, 500);
          });
        }
      } else if (type === 'alert_deleted') {
        const ids = new Set<string>(
          (Array.isArray(frame.alert_ids) ? frame.alert_ids : []).map(String)
            .concat(frame.alert_id ? [String(frame.alert_id)] : []),
        );
        if (ids.size) {
          setAlerts((prev) => prev.filter((x) => !ids.has(x._id)));
          setSelected((prev) => new Set([...prev].filter((id) => !ids.has(id))));
        }
      } else if (type === 'alert_resolved') {
        const ids = new Set<string>(
          (Array.isArray(frame.alert_ids) ? frame.alert_ids : []).map(String)
            .concat(frame.alert_id ? [String(frame.alert_id)] : []),
        );
        if (ids.size) {
          setAlerts((prev) => prev.map((x) => (
            ids.has(x._id)
              ? { ...x, status: 'resolved', resolved: true, resolved_at: x.resolved_at ?? new Date().toISOString() }
              : x
          )));
        }
      }
      scheduleResync();
    });
  }, [subscribeToNotificationEvents, passesFilters, scheduleResync]);

  // Realtime epoch bump (state counts) also resyncs the summary.
  const lastEpoch = useRef(0);
  useEffect(() => {
    if (lastEpoch.current !== 0 && notifEpoch !== lastEpoch.current) scheduleResync();
    lastEpoch.current = notifEpoch;
  }, [notifEpoch, scheduleResync]);

  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); }, []);

  const runAction = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([fetchData(), fetchSummary()]);
    } catch {
      // keep the list as-is on action failure
    } finally {
      setBusy(false);
    }
  }, [fetchData, fetchSummary]);

  const resetFilters = () => {
    setCategoryFilter(''); setSeverityFilter(''); setStatusFilter(''); setSearch(''); setPage(0);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOnPage = alerts.every((a) => next.has(a._id));
      (allOnPage ? alerts : []).forEach((a) => next.delete(a._id));
      if (!allOnPage) alerts.forEach((a) => next.add(a._id));
      return next;
    });
  };

  const doConfirm = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'single') {
        await deleteAlert(confirm.id);
        setAlerts((prev) => prev.filter((x) => x._id !== confirm.id));
        setSelected((prev) => { const n = new Set(prev); n.delete(confirm.id); return n; });
      } else if (confirm.kind === 'selected') {
        const ids = [...selected];
        await deleteAlertsMany(ids);
        setAlerts((prev) => prev.filter((x) => !ids.includes(x._id)));
        setSelected(new Set());
      } else {
        await deleteAllAlerts();
        setAlerts([]);
        setSelected(new Set());
        setTotal(0);
      }
      await Promise.all([fetchData(), fetchSummary()]);
    } catch {
      // deletion failure — surface to the user via the empty confirm close
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }, [confirm, selected, fetchData, fetchSummary]);

  const tabs = useMemo(() => {
    const byCat = summary?.byCategory ?? {};
    const entries = Object.entries(byCat).filter(([, n]) => n > 0);
    entries.sort((a, b) => {
      const ia = CANONICAL_ORDER.indexOf(a[0]);
      const ib = CANONICAL_ORDER.indexOf(b[0]);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a[0].localeCompare(b[0]);
    });
    return entries;
  }, [summary]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive = Boolean(categoryFilter || severityFilter || statusFilter || search || page !== 0);
  const nowMs = now;

  const confirmationText = (() => {
    if (!confirm) return { title: '', description: '', action: 'Delete' };
    if (confirm.kind === 'single') {
      const a = alerts.find((x) => x._id === confirm.id);
      return {
        title: 'Delete this alert?',
        description: `"${a?.title ?? 'Alert'}" will be permanently removed from the alert center. This cannot be undone.`,
        action: 'Delete alert',
      };
    }
    if (confirm.kind === 'selected') {
      return {
        title: `Delete ${selected.size} selected alert${selected.size === 1 ? '' : 's'}?`,
        description: 'The selected alerts will be permanently removed. This cannot be undone.',
        action: `Delete ${selected.size}`,
      };
    }
    return {
      title: 'Delete all alerts?',
      description: 'Every alert in the center — active and resolved — will be permanently removed. Only the append-only event ledger survives. This cannot be undone.',
      action: 'Delete everything',
    };
  })();

  const live = !offline && !!summary;
  const retentionHours = summary?.retentionHours ?? 24;

  return (
    <div className="space-y-4 pb-2">
      <PageHeader
        title="Live Alert Center"
        subtitle={
          live
            ? `${summary?.active ?? 0} active · ${summary?.today ?? 0} today · alerts expire after ${retentionHours}h`
            : 'Alerts are created only from real backend events'
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'flex items-center gap-1.5 text-[11px] font-medium',
              offline ? 'text-destructive' : 'text-success',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', offline ? 'bg-destructive' : 'bg-success animate-pulse')} />
            {offline ? 'Alert service unavailable' : 'Live'}
          </span>
          <Link href="/data-saver/settings/alerts">
            <Button size="sm" variant="ghost">
              <Settings className="h-4 w-4 mr-1.5" /> Settings
            </Button>
          </Link>
          <Button
            size="sm" variant="ghost"
            disabled={selected.size === 0}
            onClick={() => setConfirm({ kind: 'selected' })}
          >
            <Trash2 className="h-4 w-4 mr-1.5" /> Delete {selected.size > 0 ? `${selected.size}` : ''}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || total === 0}
            onClick={() => setConfirm({ kind: 'all' })}>
            <Trash2 className="h-4 w-4 mr-1.5" /> Delete all
          </Button>
        </div>
      </PageHeader>

      {offline && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>
            Alert service unavailable — showing the last successful load
            {lastGoodAt ? ` (${fmtTimestampIST(new Date(lastGoodAt).toISOString())})` : ''}.
            Data may be cached / historical, and new alerts will not appear until the backend is reachable again.
          </span>
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <section aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCard icon={Database} label="Total" value={summary.total} tone="text-muted-foreground" />
          <SummaryCard icon={Zap} label="Active" value={summary.active} tone="text-warning" />
          <SummaryCard icon={AlertOctagon} label="Critical" value={summary.critical} tone="text-destructive" />
          <SummaryCard icon={AlertTriangle} label="Warning" value={summary.warning} tone="text-warning" />
          <SummaryCard icon={CheckCircle2} label="Resolved" value={summary.resolved} tone="text-success" />
          <SummaryCard
            icon={Clock}
            label="Last alert"
            value={summary.lastAlertAt ? rel(summary.lastAlertAt, nowMs) : '—'}
            tone="text-muted-foreground"
          />
        </section>
      )}

      {/* Category tabs with real counts */}
      {summary && tabs.length > 0 && (
        <ScrollArea className="w-full">
          <div className="flex gap-1.5 pb-1 min-w-max">
            <CategoryTab
              label="All"
              count={summary.total}
              active={!categoryFilter}
              onClick={() => { setCategoryFilter(''); setPage(0); }}
            />
            {tabs.map(([cat, count]) => (
              <CategoryTab
                key={cat}
                label={cat}
                count={count}
                active={categoryFilter === cat}
                onClick={() => { setCategoryFilter(cat); setPage(0); }}
              />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}

      {/* Filters */}
      <SectionCard>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search title, message, reason, symbol, rule…"
              className="h-9 pl-8 text-xs"
            />
          </div>
          <select
            value={severityFilter}
            onChange={(e) => { setSeverityFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Severity filter"
          >
            <option value="">All severities</option>
            {['info', 'success', 'warning', 'error', 'critical'].map((s) => (
              <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Status filter"
          >
            <option value="">All statuses</option>
            {['active', 'acknowledged', 'resolved'].map((s) => (
              <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
            ))}
          </select>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>Reset</Button>
          )}
        </div>
      </SectionCard>

      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" className="h-7 text-[10px]" onClick={() => setConfirm({ kind: 'selected' })}>
              Delete selected
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <LoadingState text="Loading alert center..." />
      ) : alerts.length === 0 && !filtersActive ? (
        <EmptyState
          icon={AlertCircle}
          title="No alerts"
          description="Important system activity will appear here as it actually happens. Only real backend events produce alerts — alerts are never generated or sampled."
        />
      ) : (
        <section aria-label="Alerts" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <SectionHeading>
              Alerts ({total})
              <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                newest first · auto-expire after {retentionHours}h
              </span>
            </SectionHeading>
            {alerts.length > 0 && (
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                <input
                  type="checkbox"
                  aria-label="Select all alerts on this page"
                  checked={alerts.every((a) => selected.has(a._id))}
                  onChange={selectAllPage}
                  className="h-3.5 w-3.5 accent-primary"
                />
                Page
              </label>
            )}
          </div>

          {alerts.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No alerts match"
              description="Nothing matches the current filters"
              action={<Button size="sm" variant="outline" onClick={resetFilters}>Clear filters</Button>}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                {alerts.map((a) => {
                  const sev = a.severity ?? 'info';
                  const sevMeta = SEV_META[sev] ?? SEV_META.info;
                  const SevIcon = sevMeta.icon;
                  const status = a.status ?? 'active';
                  const statusMeta = STATUS_META[status] ?? STATUS_META.active;
                  const liveIncident =
                    status === 'active' && (nowMs - new Date(a.updated_at ?? a.created_at ?? 0).getTime()) < LIVE_WINDOW_MS;
                  const isOpen = expanded === a._id;
                  const ts: string | null = a.triggered_at ?? a.event_timestamp ?? a.created_at ?? null;
                  return (
                    <SectionCard key={a._id} className={cn(isOpen && 'border-primary/40')}>
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          aria-label={`Select ${a.title ?? 'alert'}`}
                          checked={selected.has(a._id)}
                          onChange={() => toggleSelected(a._id)}
                          className="h-3.5 w-3.5 shrink-0 accent-primary"
                        />
                        <SevIcon className={cn('h-4 w-4 shrink-0', sevMeta.cls)} />
                        <button
                          className="flex flex-1 min-w-0 items-center gap-2 py-2 text-left"
                          onClick={() => setExpanded(isOpen ? null : a._id)}
                          aria-expanded={isOpen}
                        >
                          <div className="flex min-w-0 flex-col">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium truncate max-w-[46ch]">{a.title || a.message || 'Alert'}</span>
                              {liveIncident && (
                                <span className="flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-success">
                                  <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" /> LIVE
                                </span>
                              )}
                              {status === 'acknowledged' && (
                                <span className="rounded-full bg-info/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-info">ACK</span>
                              )}
                              {status === 'resolved' && (
                                <span className="rounded-full bg-muted/60 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">HISTORICAL</span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground max-w-[70ch] truncate">{a.message}</p>
                          </div>
                        </button>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {a.category && (
                            <Badge variant="outline" className="hidden text-[9px] text-muted-foreground sm:inline-flex">
                              {a.category}
                            </Badge>
                          )}
                          {a.symbol && <Badge variant="secondary" className="hidden text-[9px] lg:inline-flex">{a.symbol}</Badge>}
                          {a.occurrence_count && a.occurrence_count > 1 ? (
                            <Badge variant="outline" className="text-[9px] tabular-nums">×{a.occurrence_count}</Badge>
                          ) : null}
                          {status !== 'resolved' && (
                            <Button
                              size="sm" variant="ghost" className="h-7 w-7 p-0"
                              disabled={busy}
                              title="Acknowledge"
                              onClick={() => runAction(() => acknowledgeAlert(a._id))}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {status !== 'resolved' && (
                            <Button
                              size="sm" variant="ghost" className="h-7 w-7 p-0"
                              disabled={busy}
                              title="Resolve"
                              onClick={() => runAction(() => resolveAlert(a._id, 'Marked resolved'))}
                            >
                              <AlertCircle className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive"
                            disabled={busy}
                            title="Delete"
                            onClick={() => setConfirm({ kind: 'single', id: a._id })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0"
                            title={isOpen ? 'Collapse' : 'Expand details'}
                            onClick={() => setExpanded(isOpen ? null : a._id)}
                          >
                            {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </div>

                      {/* Compact meta strip */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-8 pb-1 text-[10px] text-muted-foreground/70 tabular-nums">
                        {ts ? <span>{fmtTimestampIST(ts)}</span> : <span>—</span>}
                        {ts && <span>({rel(ts, nowMs)})</span>}
                        <span className="inline-flex items-center gap-1">
                          <StatusBadge status={statusMeta.badge} label={statusMeta.label} />
                        </span>
                        <SevIcon className="h-3 w-3" />
                        <span className={sevMeta.cls}>{sev}</span>
                        {durationOf(a) && <span>· lasted {durationOf(a)}</span>}
                        {a.reason_code && <span>· {a.reason_code}</span>}
                        {/* Engine self-reported incidents link straight to the
                            engine that raised them, so the alert is a doorway
                            into the diagnosis rather than a dead end. */}
                        {engineIdOf(a) && (
                          <Link
                            href={`/services/system/${engineIdOf(a)}`}
                            className="inline-flex items-center gap-1 rounded px-1 py-px font-semibold text-primary hover:bg-primary/10"
                          >
                            <Blocks className="h-3 w-3" />
                            {a.component?.replace(/^engine:/, '')}
                          </Link>
                        )}
                        {(a.occurrence_count ?? 0) > 1 && (
                          <span className="text-muted-foreground/50">
                            (seen {a.occurrence_count}× — one alert, not {a.occurrence_count})
                          </span>
                        )}
                      </div>

                      {isOpen && (
                        <div className="mt-2 border-t border-border/60 px-8 py-3 space-y-3">
                          <p className="text-xs">{a.message}</p>
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <div>{kv(2, [
                              ['Event time', ts ? fmtTimestampIST(ts) : null],
                              ['First seen', a.first_seen_at ? fmtTimestampIST(a.first_seen_at) : null],
                              ['Last seen', a.last_seen_at ? fmtTimestampIST(a.last_seen_at) : null],
                              ['Created', a.created_at ? fmtTimestampIST(a.created_at) : null],
                              ['Resolved', a.resolved_at ? fmtTimestampIST(a.resolved_at) : null],
                              ['Expires', a.expires_at ? `${fmtTimestampIST(a.expires_at)} · ${rel(a.expires_at, nowMs)}` : null],
                            ])}</div>
                            <div>{kv(2, [
                              ['Duration', durationOf(a) ?? null],
                              ['Occurrences', a.occurrence_count?.toString() ?? null],
                              ['Status', statusMeta.label],
                              ['Severity', sev],
                              ['Category', a.category ?? null],
                              ['Rule', a.rule_id ?? null],
                            ])}</div>
                          </div>
                          <div>{kv(2, [
                            ['Source', a.source ?? null],
                            ['Component', a.component ?? null],
                            ['Report context', a.symbol ? `${a.symbol}${a.exchange ? ` · ${a.exchange}` : ''}${a.token ? ` · token ${a.token}` : ''}` : null],
                            ['Reason', a.reason ?? null],
                            ['Reason code', a.reason_code ?? null],
                            ['Resolved reason', a.resolved_reason ?? null],
                          ])}</div>
                          <div>{kv(3, [
                            ['Dedupe key', a.deduplication_key ?? null],
                            ['Dedupe window', typeof a.automation?.dedupeWindow === 'number' ? `${a.automation.dedupeWindow}s` : null],
                            ['Auto-resolve on', a.automation?.autoResolveOn ?? null],
                            ['Related event', a.related_event_id ?? null],
                            ['Related notification', a.related_notification_id ?? null],
                            ['Expiry (TTL)', `auto 24h`],
                          ])}</div>
                          {a.metadata && Object.keys(a.metadata).length > 0 && (
                            <details className="rounded-lg border border-border/60 bg-muted/20 p-2">
                              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                                Technical details (event metadata)
                              </summary>
                              <pre className="mt-1.5 max-h-48 overflow-auto text-[10px] leading-relaxed text-muted-foreground">
                                {JSON.stringify(a.metadata, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                    </SectionCard>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="mt-2 flex items-center justify-between border-t border-border/50 pt-3">
                  <Button size="sm" variant="ghost" disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Prev
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">{page + 1} / {totalPages}</span>
                  <Button size="sm" variant="ghost" disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                    Next <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => { if (!o && !busy) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmationText.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmationText.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void doConfirm(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? 'Deleting…' : confirmationText.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SummaryCard({
  icon: Icon, label, value, tone,
}: {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card/60 p-3">
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted', tone)}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('truncate text-base font-bold tabular-nums leading-tight', tone)}>{value}</p>
      </div>
    </div>
  );
}

function CategoryTab({
  label, count, active, onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
      <span className={cn('tabular-nums', active ? 'text-primary' : 'text-muted-foreground/60')}>{count}</span>
    </button>
  );
}