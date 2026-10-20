'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Check, CheckCheck, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { useRealtime } from '@/components/realtime-provider';
import { getNotifications } from '@/lib/api';
import { dedupeFetch } from '@/lib/shared-request';
import { useUnreadCount, notificationActions, type SharedNotification } from '@/lib/shared-notifications';
import { fmtAgo } from '@/lib/topbar-status';
import { cn } from '@/lib/utils';
import type { ShellConfig } from '@/components/layout/nav';

type Row = {
  id: string;
  title: string;
  message: string;
  read: boolean;
  level: string;
  ts?: string;
};

function toRow(n: any): Row {
  return {
    id: String(n?._id ?? n?.notification_id ?? ''),
    title: n?.title || 'Notification',
    message: n?.message || n?.reason || '',
    read: Boolean(n?.read ?? false),
    level: String(n?.level ?? n?.severity ?? 'info'),
    ts: n?.ts ?? n?.created_at,
  };
}

function levelDot(level: string): string {
  const l = level.toLowerCase();
  if (l.includes('danger') || l.includes('error') || l.includes('critical')) return 'bg-destructive';
  if (l.includes('warn')) return 'bg-warning';
  if (l.includes('success')) return 'bg-success';
  return 'bg-info';
}

export function NotificationCenter({ config }: { config: ShellConfig }) {
  const router = useRouter();
  const rt = useRealtime();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  // Realtime-first: the SSE already pushes latest notifications.
  const realtimeRows = useMemo(
    () => rt.notificationsState.latestNotifications.map(toRow),
    [rt.notificationsState.latestNotifications],
  );
  const live = rt.hydrated && realtimeRows.length > 0 ? realtimeRows : items;

  // Lazy reconciliation fetch (single shared dedupe request) only when the
  // drawer opens and realtime hasn't pushed rows yet — never a poll loop.
  useEffect(() => {
    if (!open || (rt.hydrated && realtimeRows.length > 0)) return;
    let alive = true;
    setLoading(true);
    dedupeFetch('topbar:notifications', () => getNotifications('?limit=30'), { ttlMs: 5000 })
      .then((r) => {
        if (alive) setItems((r?.notifications ?? []).map(toRow));
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, rt.hydrated, realtimeRows.length]);

  // Real-time toast on new notification frames.
  useEffect(() => {
    return rt.subscribeToNotificationEvents((frame) => {
      if (String(frame.type) !== 'notification_created') return;
      const n = (frame.notification ?? {}) as Record<string, any>;
      if (!n || !n._id) return;
      toast(n.title || 'New notification', {
        description: n.message || undefined,
      });
    });
  }, [rt]);

  const markAll = async () => {
    try {
      await notificationActions.markAllRead();
      setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    } catch { /* mutations are best-effort; realtime reconciles */ }
  };

  const markOne = async (row: Row) => {
    if (row.read) return;
    try {
      await notificationActions.markRead(row.id);
      setItems((prev) => prev.map((i) => (i.id === row.id ? { ...i, read: true } : i)));
    } catch { /* ignore */ }
  };

  const dismissOne = async (row: Row) => {
    try {
      await notificationActions.delete(row.id);
      setItems((prev) => prev.filter((i) => i.id !== row.id));
    } catch { /* ignore */ }
  };

  const unreadNow = live.filter((i) => !i.read).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onMouseDown={(e) => e.preventDefault()}>
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
          className="relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:h-9 lg:w-9"
        >
          <Bell className="size-[18px]" aria-hidden />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold leading-none text-destructive-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[min(94vw,360px)] p-0">
        <div className="rounded-lg border bg-popover/95 backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Bell className="size-4 text-foreground/80" aria-hidden />
              <p className="text-sm font-semibold tracking-tight">Notifications</p>
              {unreadNow > 0 && (
                <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[10px] font-bold text-destructive">
                  {unreadNow > 99 ? '99+' : unreadNow} new
                </span>
              )}
            </div>
            {unreadNow > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <CheckCheck className="size-3" aria-hidden /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-[min(55vh,380px)] overflow-y-auto">
            {loading && live.length === 0 ? (
              <Empty icon={<Loader2 className="size-5 animate-spin opacity-40" />} label="Loading…" />
            ) : live.length === 0 ? (
              <Empty icon={<Bell className="size-5 opacity-40" />} label="No notifications" />
            ) : (
              <ul className="divide-y divide-border/50">
                {live.slice(0, 30).map((row) => (
                  <li key={row.id}>
                    <div
                      className={cn(
                        'group flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/40',
                        !row.read && 'bg-primary/5',
                      )}
                    >
                      <span
                        className={cn('mt-1.5 size-2 shrink-0 rounded-full', levelDot(row.level))}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate text-xs font-medium', !row.read ? 'text-foreground' : 'text-muted-foreground')}>
                          {row.title}
                        </p>
                        {row.message && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{row.message}</p>
                        )}
                        <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/60">
                          {fmtAgo(row.ts ?? null)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        {!row.read && (
                          <button
                            type="button"
                            onClick={() => markOne(row)}
                            aria-label={`Mark "${row.title}" as read`}
                            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <Check className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => dismissOne(row)}
                          aria-label={`Dismiss "${row.title}"`}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-border/60 p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (config.notificationsRoute) router.push(config.notificationsRoute);
              }}
              className="flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              View all notifications
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Empty({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
      {icon}
      <p className="text-xs">{label}</p>
    </div>
  );
}

export type { SharedNotification };