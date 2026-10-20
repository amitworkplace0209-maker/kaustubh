'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertCircle,
  Bell,
  BellRing,
  Blocks,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
FileDown,
  Inbox,
  Mail,
  MailOpen,
  Search,
  Send,
  Server,
  Settings,
  Shield,
  Trash2,
  Users,
  Wifi,
  WifiOff,
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
  PageHeader, SectionCard, SectionHeading, EmptyState, LoadingState,
} from '@/components/design-system';
import { fmtTimestampIST } from '@/lib/formatters';
import { useRealtime } from '@/components/realtime-provider';
import {
  getNotifications, getNotificationSummary,
  markNotificationRead, markNotificationUnread, markAllNotificationsRead,
  markNotificationsMany, deleteNotification, deleteNotificationsMany,
  deleteReadNotifications, clearAllNotifications,
  buildQuery,
} from '@/lib/api';

interface NotificationItem {
  _id: string;
  category?: string;
  severity?: string;
  importance?: 'normal' | 'high' | string;
  title?: string;
  message?: string;
  source?: string;
  event_type?: string;
  read?: boolean;
  status?: string;
  component?: string;
  reason?: string;
  reason_code?: string;
  symbol?: string;
  occurrence_count?: number;
  related_alert_id?: string;
  related_event_id?: string;
  ts?: string;
  created_at?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  read_at?: string;
  metadata?: Record<string, unknown>;
}

interface NotificationsResponse {
  notifications: NotificationItem[];
  total: number;
  unreadCount: number;
  categories: Record<string, number>;
  sources: string[];
  summary?: Summary;
  live?: boolean;
  retentionDays?: number;
}

interface Summary {
  total: number;
  unread: number;
  read: number;
  today: number;
  important: number;
  critical?: number;
  warnings?: number;
  highUnread?: number;
  lastNotificationAt?: string | null;
  byCategory: Record<string, number>;
  live?: boolean;
  retentionDays?: number;
}

const PAGE_SIZE = 20;

const NOTIFICATION_CATEGORIES = [
  'MARKET', 'WEBSOCKET', 'SESSION', 'DOWNLOADS', 'EXPORTS',
  'SUBSCRIPTIONS', 'SCHEDULER', 'DATA', 'SETTINGS', 'SYSTEM',
] as const;

const CATEGORY_ICON: Record<string, { icon: React.ElementType; cls: string }> = {
  MARKET: { icon: Activity, cls: 'text-info' },
  WEBSOCKET: { icon: Wifi, cls: 'text-primary' },
  SESSION: { icon: Users, cls: 'text-success' },
  DOWNLOADS: { icon: FileDown, cls: 'text-primary' },
  EXPORTS: { icon: Send, cls: 'text-info' },
  SUBSCRIPTIONS: { icon: BellRing, cls: 'text-warning' },
  SCHEDULER: { icon: CalendarClock, cls: 'text-warning' },
  DATA: { icon: Server, cls: 'text-info' },
  SETTINGS: { icon: Settings, cls: 'text-muted-foreground' },
  SYSTEM: { icon: Shield, cls: 'text-muted-foreground' },
};

const SEV_META: Record<string, { dot: string; chip: string; label: string }> = {
  info: { dot: 'bg-info', chip: 'text-info border-info/30 bg-info/10', label: 'Info' },
  success: { dot: 'bg-success', chip: 'text-success border-success/30 bg-success/10', label: 'Success' },
  warning: { dot: 'bg-warning', chip: 'text-warning border-warning/30 bg-warning/10', label: 'Warning' },
  error: { dot: 'bg-destructive', chip: 'text-destructive border-destructive/30 bg-destructive/10', label: 'Error' },
  critical: { dot: 'bg-destructive', chip: 'text-destructive border-destructive/30 bg-destructive/10', label: 'Critical' },
};

/**
 * Engine id behind an engine self-reported notification, or null for any other
 * source. The reporter writes `component = "engine:<id>"`; nothing else uses
 * that shape.
 */
function engineIdOf(n: NotificationItem): string | null {
  const c = n.component ?? '';
  if (!c.startsWith('engine:')) return null;
  return c.slice('engine:'.length).trim() || null;
}

function rel(iso: string | null | undefined, now: number): string {  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 15_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function Phase2NotificationsPage() {
  const { notifEpoch, subscribeToNotificationEvents, hydrated } = useRealtime();

  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [offline, setOffline] = useState(false);
  const [lastGoodAt, setLastGoodAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [importanceFilter, setImportanceFilter] = useState('');
  const [rangeFilter, setRangeFilter] = useState(''); // '', 24h, 7d, 30d
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | { kind: 'single'; id: string } | { kind: 'selected' } | { kind: 'read' } | { kind: 'all' }>(null);
  const [busy, setBusy] = useState(false);

  const filtersRef = useRef({ categoryFilter, statusFilter, severityFilter, importanceFilter, rangeFilter, search, page });
  filtersRef.current = { categoryFilter, statusFilter, severityFilter, importanceFilter, rangeFilter, search, page };
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lightweight clock: re-render the relative labels occasionally.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const sinceIso = useCallback((range: string): string => {
    if (!range) return '';
    const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : range === '30d' ? 24 * 30 : 0;
    if (!hours) return '';
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }, []);

  const queryParams = useCallback((f: typeof filtersRef.current = filtersRef.current) => {
    const since = sinceIso(f.rangeFilter);
    return buildQuery({
      limit: PAGE_SIZE,
      offset: f.page * PAGE_SIZE,
      category: f.categoryFilter || '',
      status: f.statusFilter || '',
      severity: f.severityFilter || '',
      importance: f.importanceFilter || '',
      since: since || '',
      search: f.search.trim() || '',
    });
  }, [sinceIso]);

  const fetchData = useCallback(async () => {
    let res: NotificationsResponse;
    try {
      res = await getNotifications(queryParams()) as NotificationsResponse;
    } catch {
      setOffline(true);
      setLoading(false);
      return;
    }
    setOffline(false);
    setLastGoodAt(Date.now());
    setNotifications(res?.notifications ?? []);
    setTotal(res?.total ?? 0);
    if (res?.summary) setSummary(res.summary);
    setLoading(false);
  }, [queryParams]);

  const fetchSummary = useCallback(async () => {
    try {
      const s = await getNotificationSummary() as Summary;
      setSummary(s);
      setOffline(false);
      setLastGoodAt(Date.now());
    } catch {
      // keep previous summary; offline banner is driven by fetchData
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void fetchData();
    void fetchSummary();
  }, [fetchData, fetchSummary]);

  // Debounced re-sync after realtime frames — local merge keeps the list live,
  // the debounce avoids hammering the API during bursts.
  const scheduleResync = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void fetchData();
      void fetchSummary();
    }, 450);
  }, [fetchData, fetchSummary]);

  const passesFilters = useCallback((n: NotificationItem) => {
    const f = filtersRef.current;
    if (f.categoryFilter && n.category !== f.categoryFilter) return false;
    if (f.statusFilter === 'unread' && n.read) return false;
    if (f.statusFilter === 'read' && !n.read) return false;
    if (f.severityFilter && n.severity !== f.severityFilter) return false;
    if (f.importanceFilter && n.importance !== f.importanceFilter) return false;
    if (f.rangeFilter) {
      const iso = sinceIso(f.rangeFilter);
      if (iso && (!n.ts || new Date(n.ts).getTime() < new Date(iso).getTime())) return false;
    }
    if (f.search.trim()) {
      const q = f.search.trim().toLowerCase();
      const hay = [n.title, n.message, n.source, n.event_type, n.reason_code, n.component, n.category]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }, [sinceIso]);

  useEffect(() => {
    return subscribeToNotificationEvents((frame) => {
      const type = String(frame.type ?? '');
      if (type === 'notification_created') {
        const n = (frame.notification as NotificationItem | undefined) ?? null;
        if (n?._id) {
          setNotifications((prev) => {
            if (prev.some((x) => x._id === n._id)) return prev;
            if (!passesFilters(n)) return prev;
            return [n, ...prev].slice(0, 500);
          });
        }
      } else if (type === 'notification_updated') {
        const ids = new Set<string>(
          (Array.isArray(frame.notification_ids) ? frame.notification_ids : []).map(String)
            .concat(frame.notification_id ? [String(frame.notification_id)] : []),
        );
        const read = typeof frame.read === 'boolean' ? frame.read : undefined;
        if (ids.size && read !== undefined) {
          setNotifications((prev) => prev.map((x) => (
            ids.has(x._id) ? { ...x, read, status: read ? 'read' : 'unread' } : x
          )));
          setSelected((prev) => new Set([...prev].filter((id) => !ids.has(id) || !read)));
        }
      } else if (type === 'notification_deleted') {
        const ids = new Set<string>(
          (Array.isArray(frame.notification_ids) ? frame.notification_ids : []).map(String)
            .concat(frame.notification_id ? [String(frame.notification_id)] : []),
        );
        if (ids.size) {
          setNotifications((prev) => prev.filter((x) => !ids.has(x._id)));
          setSelected((prev) => new Set([...prev].filter((id) => !ids.has(id))));
        }
      } else {
        return;
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
    setCategoryFilter(''); setStatusFilter(''); setSeverityFilter('');
    setImportanceFilter(''); setRangeFilter(''); setSearch(''); setPage(0);
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
      const allOnPage = notifications.every((a) => next.has(a._id));
      (allOnPage ? notifications : []).forEach((a) => next.delete(a._id));
      if (!allOnPage) notifications.forEach((a) => next.add(a._id));
      return next;
    });
  };

  const doConfirm = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === 'single') {
        await deleteNotification(confirm.id);
        setNotifications((prev) => prev.filter((x) => x._id !== confirm.id));
        setSelected((prev) => { const n = new Set(prev); n.delete(confirm.id); return n; });
      } else if (confirm.kind === 'selected') {
        const ids = [...selected];
        await deleteNotificationsMany(ids);
        setNotifications((prev) => prev.filter((x) => !ids.includes(x._id)));
        setSelected(new Set());
      } else if (confirm.kind === 'read') {
        await deleteReadNotifications();
        setNotifications((prev) => prev.filter((x) => !x.read));
        setSelected(new Set());
      } else {
        await clearAllNotifications();
        setNotifications([]);
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
    return NOTIFICATION_CATEGORIES
      .map((cat) => [cat, byCat[cat] ?? 0] as const)
      .filter(([, n]) => n > 0);
  }, [summary]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive = Boolean(categoryFilter || statusFilter || severityFilter || importanceFilter || rangeFilter || search || page !== 0);
  const nowMs = now;
  const unread = (summary?.unread ?? (hydrated ? 0 : null)) ?? notifications.filter((n) => !n.read).length;
  const live = !offline && !!summary;
  const retentionDays = summary?.retentionDays ?? 60;

  const doMarkSelected = async (read: boolean) => {
    const ids = [...selected];
    if (!ids.length) return;
    await runAction(() => markNotificationsMany(ids, read));
    setNotifications((prev) => prev.map((x) => (ids.includes(x._id) ? { ...x, read, status: read ? 'read' : 'unread' } : x)));
    if (read) setSelected(new Set());
  };

  const markSingle = async (id: string, read: boolean) => {
    await runAction(() => (read ? markNotificationRead(id) : markNotificationUnread(id)));
    setNotifications((prev) => prev.map((x) => (x._id === id ? { ...x, read, status: read ? 'read' : 'unread' } : x)));
  };

  const confirmationText = (() => {
    if (!confirm) return { title: '', description: '', action: 'Delete' };
    if (confirm.kind === 'single') {
      const n = notifications.find((x) => x._id === confirm.id);
      return {
        title: 'Delete this notification?',
        description: `"${n?.title ?? 'Notification'}" will be permanently removed. This cannot be undone.`,
        action: 'Delete',
      };
    }
    if (confirm.kind === 'selected') {
      return {
        title: `Delete ${selected.size} selected notification${selected.size === 1 ? '' : 's'}?`,
        description: 'The selected notifications will be permanently removed. This cannot be undone.',
        action: `Delete ${selected.size}`,
      };
    }
    if (confirm.kind === 'read') {
      return {
        title: 'Delete all read notifications?',
        description: 'Every notification already marked as read will be permanently removed. Unread notifications are kept. This cannot be undone.',
        action: 'Delete read',
      };
    }
    return {
      title: 'Delete all notifications?',
      description: 'Every notification — read and unread — will be permanently removed. Only the append-only event ledger survives. This cannot be undone.',
      action: 'Delete everything',
    };
  })();

  return (
    <div className="space-y-4 pb-2">
      <PageHeader
        title="Notifications"
        subtitle={
          live
            ? `${unread} unread · ${summary?.today ?? 0} today · read notifications held ${retentionDays}d`
            : 'Notifications are created only from real backend events'
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
            {offline ? 'Notification service unavailable' : 'Live'}
          </span>
          <Link href="/data-saver/settings/notifications">
            <Button size="sm" variant="ghost">
              <Settings className="h-4 w-4 mr-1.5" /> Settings
            </Button>
          </Link>
          <Button size="sm" variant="ghost"
            disabled={busy || unread === 0}
            onClick={() => runAction(markAllNotificationsRead)}>
            <CheckCheck className="h-4 w-4 mr-1.5" /> Mark all read
          </Button>
          <Button size="sm" variant="ghost"
            disabled={busy || (summary?.read ?? 0) === 0}
            onClick={() => setConfirm({ kind: 'read' })}>
            <Trash2 className="h-4 w-4 mr-1.5" /> Delete read
          </Button>
          <Button size="sm" variant="ghost"
            disabled={busy || total === 0}
            onClick={() => setConfirm({ kind: 'all' })}>
            <Trash2 className="h-4 w-4 mr-1.5" /> Delete all
          </Button>
        </div>
      </PageHeader>

      {offline && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>
            Notification service unavailable — showing the last successful load
            {lastGoodAt ? ` (${fmtTimestampIST(new Date(lastGoodAt).toISOString())})` : ''}.
            Data may be cached / historical, and new notifications will not appear until the backend is reachable again.
          </span>
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <section aria-label="Summary" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCard icon={MailOpen} label="Unread" value={unread} tone="text-primary" />
          <SummaryCard icon={AlertCircle} label="Important" value={summary.important} tone="text-destructive" />
          <SummaryCard icon={Clock} label="Today" value={summary.today} tone="text-warning" />
          <SummaryCard icon={CheckCircle2} label="Read" value={summary.read} tone="text-success" />
          <SummaryCard icon={Inbox} label="Total" value={summary.total} tone="text-muted-foreground" />
          <SummaryCard
            icon={Bell}
            label="Last notification"
            value={summary.lastNotificationAt ? rel(summary.lastNotificationAt, nowMs) : '—'}
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
              placeholder="Search title, message, source, event…"
              className="h-9 pl-8 text-xs"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Status filter"
          >
            <option value="">All statuses</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
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
            value={importanceFilter}
            onChange={(e) => { setImportanceFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Importance filter"
          >
            <option value="">All importance</option>
            <option value="high">Important</option>
            <option value="normal">Normal</option>
          </select>
          <select
            value={rangeFilter}
            onChange={(e) => { setRangeFilter(e.target.value); setPage(0); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Time range filter"
          >
            <option value="">Any time</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>Reset</Button>
          )}
        </div>
      </SectionCard>

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs">
          <span className="font-medium">{selected.size} selected</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" className="h-7 text-[10px]" disabled={busy} onClick={() => void doMarkSelected(true)}>
              <Check className="h-3.5 w-3.5 mr-1" /> Mark read
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={busy} onClick={() => void doMarkSelected(false)}>
              <Mail className="h-3.5 w-3.5 mr-1" /> Mark unread
            </Button>
            <Button size="sm" className="h-7 text-[10px] bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={busy}
              onClick={() => setConfirm({ kind: 'selected' })}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <LoadingState text="Loading notifications..." />
      ) : notifications.length === 0 && !filtersActive ? (
        <EmptyState
          icon={BellRing}
          title="No notifications"
          description="Real backend activity will appear here as it actually happens. Notifications are never generated, simulated or sampled."
        />
      ) : (
        <section aria-label="Notifications" className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <SectionHeading>
              Notifications ({total})
              <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                newest first · read notifications held {retentionDays}d
              </span>
            </SectionHeading>
            {notifications.length > 0 && (
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground select-none">
                <input
                  type="checkbox"
                  aria-label="Select all notifications on this page"
                  checked={notifications.every((a) => selected.has(a._id))}
                  onChange={selectAllPage}
                  className="h-3.5 w-3.5 accent-primary"
                />
                Page
              </label>
            )}
          </div>

          {notifications.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No notifications match"
              description="Nothing matches the current filters"
              action={<Button size="sm" variant="outline" onClick={resetFilters}>Clear filters</Button>}
            />
          ) : (
            <>
              <div className="space-y-1.5">
                {notifications.map((n) => {
                  const sev = n.severity ?? 'info';
                  const sevMeta = SEV_META[sev] ?? SEV_META.info;
                  const catMeta = CATEGORY_ICON[n.category ?? ''] ?? CATEGORY_ICON.SYSTEM;
                  const CatIcon = catMeta.icon;
                  const isRead = !!n.read;
                  const isOpen = expanded === n._id;
                  const ts: string | null = n.ts ?? n.created_at ?? null;
                  return (
                    <SectionCard key={n._id} className={cn(!isRead && 'bg-card/50', isOpen && 'border-primary/40')}>
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          aria-label={`Select ${n.title ?? 'notification'}`}
                          checked={selected.has(n._id)}
                          onChange={() => toggleSelected(n._id)}
                          className="h-3.5 w-3.5 shrink-0 accent-primary"
                        />
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', isRead ? 'bg-border' : sevMeta.dot)} />
                        <Link
                          href={`/data-saver/notifications/${n._id}`}
                          className="flex flex-1 min-w-0 items-center gap-2 py-2 text-left"
                        >
                          <div className="flex min-w-0 flex-col">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className={cn('text-sm truncate max-w-[46ch]', isRead ? 'font-medium text-muted-foreground' : 'font-medium')}>
                                {n.title || n.message || 'Notification'}
                              </span>
                              {!isRead && (
                                <span className="rounded-full bg-primary/15 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-primary">UNREAD</span>
                              )}
                              {isRead && (
                                <span className="rounded-full bg-muted/60 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">READ</span>
                              )}
                              {n.importance === 'high' && (
                                <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-destructive">IMPORTANT</span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground max-w-[70ch] truncate">{n.message}</p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                              {ts ? <span>{fmtTimestampIST(ts)} · {rel(ts, nowMs)}</span> : <span>—</span>}
                              {n.source && <span>· {n.source}</span>}
                              {n.component && <span>· {n.component}</span>}
                              {n.event_type && <span>· {n.event_type}</span>}
                              {n.symbol && <span>· {n.symbol}</span>}
                            </div>
                          </div>
                        </Link>
                        <div className="flex shrink-0 items-center gap-1">
                          <Badge variant="outline" className={cn('hidden text-[9px] sm:inline-flex', sevMeta.chip)}>
                            {sev}
                          </Badge>
                          <Badge variant="outline" className="hidden text-[9px] text-muted-foreground sm:inline-flex">
                            <CatIcon className={cn('h-2.5 w-2.5 mr-1', catMeta.cls)} />
                            {n.category ?? 'SYSTEM'}
                          </Badge>
                          {n.occurrence_count && n.occurrence_count > 1 ? (
                            <Badge variant="outline" className="text-[9px] tabular-nums">×{n.occurrence_count}</Badge>
                          ) : null}
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0"
                            disabled={busy}
                            title={isRead ? 'Mark unread' : 'Mark read'}
                            onClick={() => void markSingle(n._id, !isRead)}
                          >
                            {isRead ? <Mail className="h-3.5 w-3.5" /> : <MailOpen className="h-3.5 w-3.5 text-primary" />}
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive"
                            disabled={busy}
                            title="Delete"
                            onClick={() => setConfirm({ kind: 'single', id: n._id })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm" variant="ghost" className="h-7 w-7 p-0"
                            title={isOpen ? 'Collapse details' : 'Expand details'}
                            onClick={() => setExpanded(isOpen ? null : n._id)}
                          >
                            {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      </div>

                      {/* Engine self-reported incidents get a doorway into the
                          engine that raised them. Kept OUT of the title link
                          above — an anchor inside an anchor is invalid and
                          would break both navigations. */}
                      {(engineIdOf(n) || (n.occurrence_count ?? 0) > 1) && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-11 pb-1.5 text-[10px] text-muted-foreground/70">
                          {engineIdOf(n) && (
                            <Link
                              href={`/services/system/${engineIdOf(n)}`}
                              className="inline-flex items-center gap-1 rounded px-1 py-px font-semibold text-primary hover:bg-primary/10"
                            >
                              <Blocks className="h-3 w-3" />
                              {String(n.component ?? '').replace(/^engine:/, '')}
                            </Link>
                          )}
                          {(n.occurrence_count ?? 0) > 1 && (
                            <span>
                              Seen {n.occurrence_count}× — one notification, counted, not {n.occurrence_count} copies
                            </span>
                          )}
                        </div>
                      )}

                      {isOpen && (
                        <div className="mt-2 border-t border-border/60 px-11 py-3 space-y-3">
                          <p className="text-xs">{n.message}</p>
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <div>{kv(2, [
                              ['Event time', ts ? fmtTimestampIST(ts) : null],
                              ['First seen', n.first_seen_at ? fmtTimestampIST(n.first_seen_at) : null],
                              ['Last seen', n.last_seen_at ? fmtTimestampIST(n.last_seen_at) : null],
                              ['Created', n.created_at ? fmtTimestampIST(n.created_at) : null],
                              ['Read at', n.read_at ? fmtTimestampIST(n.read_at) : null],
                              ['Status', isRead ? 'Read' : 'Unread'],
                            ])}</div>
                            <div>{kv(2, [
                              ['Category', n.category ?? null],
                              ['Severity', sev],
                              ['Importance', n.importance ?? null],
                              ['Source', n.source ?? null],
                              ['Component', n.component ?? null],
                              ['Event type', n.event_type ?? null],
                            ])}</div>
                          </div>
                          <div>{kv(2, [
                            ['Reason', n.reason ?? null],
                            ['Reason code', n.reason_code ?? null],
                            ['Related event', n.related_event_id ?? null],
                            ['Related alert', n.related_alert_id ?? null],
                            ['Occurrences', n.occurrence_count?.toString() ?? null],
                            ['Open detail', 'Tap the title to open the full notification page'],
                          ])}</div>
                          {n.metadata && Object.keys(n.metadata).length > 0 && (
                            <details className="rounded-lg border border-border/60 bg-muted/20 p-2">
                              <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                                Technical details (event metadata)
                              </summary>
                              <pre className="mt-1.5 max-h-48 overflow-auto text-[10px] leading-relaxed text-muted-foreground">
                                {JSON.stringify(n.metadata, null, 2)}
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