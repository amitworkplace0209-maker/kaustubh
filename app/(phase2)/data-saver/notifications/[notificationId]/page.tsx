'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertCircle, ArrowLeft, Bell, Check, Mail, Trash2, WifiOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  PageHeader, SectionCard, StatusBadge, LoadingState, EmptyState,
} from '@/components/design-system';
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
import { fmtTimestampIST } from '@/lib/formatters';
import { useRealtime } from '@/components/realtime-provider';
import {
  getNotificationDetail, markNotificationRead, markNotificationUnread, deleteNotification,
} from '@/lib/api';

interface NotificationItem {
  _id: string;
  category?: string;
  severity?: string;
  importance?: 'normal' | 'high' | string;
  level?: string;
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
  deduplication_key?: string;
  ts?: string;
  created_at?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  read_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

const SEV_META: Record<string, { chip: string; label: string }> = {
  info: { chip: 'text-info border-info/30 bg-info/10', label: 'Info' },
  success: { chip: 'text-success border-success/30 bg-success/10', label: 'Success' },
  warning: { chip: 'text-warning border-warning/30 bg-warning/10', label: 'Warning' },
  error: { chip: 'text-destructive border-destructive/30 bg-destructive/10', label: 'Error' },
  critical: { chip: 'text-destructive border-destructive/30 bg-destructive/10', label: 'Critical' },
};

const ROWS: { key: keyof NotificationItem | string; label: string; ts?: boolean }[] = [
  { key: 'ts', label: 'Event time', ts: true },
  { key: 'created_at', label: 'Created at', ts: true },
  { key: 'first_seen_at', label: 'First seen at', ts: true },
  { key: 'last_seen_at', label: 'Last seen at', ts: true },
  { key: 'read_at', label: 'Read at', ts: true },
  { key: 'category', label: 'Category' },
  { key: 'severity', label: 'Severity' },
  { key: 'importance', label: 'Importance' },
  { key: 'level', label: 'Level' },
  { key: 'source', label: 'Source' },
  { key: 'component', label: 'Component' },
  { key: 'event_type', label: 'Event type' },
  { key: 'reason_code', label: 'Reason code' },
  { key: 'deduplication_key', label: 'Deduplication key' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'occurrence_count', label: 'Occurrences' },
  { key: 'related_event_id', label: 'Related ledger event' },
  { key: 'related_alert_id', label: 'Related alert' },
];

export default function NotificationDetailPage() {
  const params = useParams<{ notificationId: string }>();
  const router = useRouter();
  const { notifEpoch, hydrated } = useRealtime();
  const id = params?.notificationId ?? '';
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<NotificationItem | null>(null);
  const [offline, setOffline] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoMarked = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchOne = useCallback(async () => {
    if (!id) return;
    try {
      const res = await getNotificationDetail(id);
      if (!mountedRef.current) return;
      setOffline(false);
      setNotification((res?.notification ?? res) as NotificationItem);
    } catch {
      if (mountedRef.current) {
        setOffline(true);
        setNotification(null);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchOne(); }, [fetchOne]);

  // Live refresh on realtime frames.
  const lastEpoch = useRef(0);
  useEffect(() => {
    if (!hydrated) return;
    if (lastEpoch.current !== 0 && notifEpoch !== lastEpoch.current) fetchOne();
    lastEpoch.current = notifEpoch;
  }, [notifEpoch, hydrated, fetchOne]);

  // Opening a notification marks it read (auto-acknowledge on read).
  useEffect(() => {
    if (!notification?._id) return;
    if (notification.read || autoMarked.current) return;
    autoMarked.current = true;
    const idToMark = notification._id;
    markNotificationRead(idToMark)
      .then(() => {
        if (mountedRef.current) {
          setNotification((prev) => prev && prev._id === idToMark
            ? { ...prev, read: true, status: 'read' }
            : prev);
        }
      })
      .catch(() => { /* best-effort auto-mark; the toggle remains available */ });
  }, [notification]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await fetchOne();
    } catch {
      // keep page as-is
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteNotification(id);
      if (mountedRef.current) router.push('/data-saver/notifications');
    } catch {
      if (mountedRef.current) setConfirmDelete(false);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const sev = useMemo(() => notification?.severity ?? 'info', [notification]);
  const sevMeta = SEV_META[sev] ?? SEV_META.info;
  const isRead = !!notification?.read;

  if (loading) return <LoadingState text="Loading notification..." />;

  if (!notification) {
    return (
      <div className="space-y-4 pb-2">
        <EmptyState
          icon={AlertCircle}
          title="Notification not found"
          description={
            offline
              ? 'The notification service is unavailable. Cached data could not be loaded — check your connection to the backend.'
              : 'This notification may have been deleted or the id is invalid'
          }
          action={
            offline
              ? <Button size="sm" variant="outline" onClick={fetchOne}><WifiOff className="h-4 w-4 mr-1.5" /> Retry</Button>
              : <Button size="sm" variant="outline" onClick={() => router.push('/data-saver/notifications')}>Back to notifications</Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-2">
      <PageHeader
        title={notification.title || 'Notification'}
        subtitle={notification.message ?? 'System notification'}
      >
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn('text-[10px]', sevMeta.chip)}>{sev}</Badge>
          {notification.category && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">{notification.category}</Badge>
          )}
          {notification.importance === 'high' && (
            <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30 bg-destructive/10">IMPORTANT</Badge>
          )}
          <StatusBadge status={isRead ? 'success' : 'warning'} label={isRead ? 'Read' : 'Unread'} />
          <Button size="sm" variant="ghost" onClick={() => router.push('/data-saver/notifications')}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back
          </Button>
          <Button
            size="sm" variant="ghost" disabled={busy}
            onClick={() => run(() => (isRead ? markNotificationUnread(id) : markNotificationRead(id)))}
          >
            {isRead
              ? <><Mail className="h-4 w-4 mr-1.5" /> Mark unread</>
              : <><Check className="h-4 w-4 mr-1.5" /> Mark read</>}
          </Button>
          <Button
            size="sm" variant="ghost" className="text-destructive" disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-4 w-4 mr-1.5" /> Delete
          </Button>
        </div>
      </PageHeader>

      {offline && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <WifiOff className="h-4 w-4 shrink-0" />
          <span>Notification service unavailable — this page may show cached / historical data.</span>
        </div>
      )}

      <SectionCard title="Details">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            <Bell className="h-3 w-3 mr-1" /> Recommended for you — created from a real event
          </Badge>
          {notification.source && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">Source: {notification.source}</Badge>
          )}
        </div>
        {notification.message && <p className="text-sm text-muted-foreground mb-3">{notification.message}</p>}
        {notification.reason && (
          <p className="text-xs mb-2"><span className="font-medium text-foreground">Reason:</span> {notification.reason}</p>
        )}
        {notification.read_at && (
          <p className="text-xs mb-2"><span className="font-medium text-foreground">Read at:</span> {fmtTimestampIST(notification.read_at)}</p>
        )}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {ROWS.map(({ key, label, ts }) => {
            const v = notification[key as keyof NotificationItem];
            if (v === undefined || v === null || v === '' || (typeof v === 'number' && isNaN(v))) return null;
            const text = ts ? fmtTimestampIST(String(v)) : String(v);
            return (
              <div key={key} className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5">
                <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
                <dd className="text-right text-xs tabular-nums break-all">{text}</dd>
              </div>
            );
          })}
          {notification.updated_at && (
            <div className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5">
              <dt className="text-[11px] font-medium text-muted-foreground">Updated at</dt>
              <dd className="text-right text-xs tabular-nums">{fmtTimestampIST(notification.updated_at)}</dd>
            </div>
          )}
        </dl>
      </SectionCard>

      {notification.metadata && Object.keys(notification.metadata).length > 0 && (
        <SectionCard title="Event metadata">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {Object.entries(notification.metadata).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-3 border-b border-border/20 py-1.5">
                <dt className="text-[11px] font-medium text-muted-foreground">{k}</dt>
                <dd className="text-right text-xs break-all">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={(o) => { if (!o && !busy) setConfirmDelete(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this notification?</AlertDialogTitle>
            <AlertDialogDescription>
              "{notification.title || 'Notification'}" will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void doDelete(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}