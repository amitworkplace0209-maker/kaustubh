'use client';

// Shared notifications layer for the whole KAUSTUBH platform.
//
// Single source of truth for unread-count + feed across ALL products
// (Trading, Data Saver, Services, Khumbha AI).
//
// Data flow: the backend pushes the authoritative `notifications` document
// over the persistent WebSocket (see lib/realtime-store.ts) — the feed, the
// unread count and the alert summary all arrive in ONE frame. The REST calls
// below are only the DEGRADED fallback: they run while the socket has no
// document yet (backend down / not logged in) and stop the moment the socket
// delivers one. Never fabricates data.

import { useCachedResource } from '@/lib/shared-request';
import {
  getNotifications,
  getAlertSummary,
  markNotificationRead,
  markNotificationUnread,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
} from '@/lib/api';
import { useRealtimeChannel } from '@/hooks/use-realtime-channel';

export type SharedNotification = {
  _id: string;
  category?: string;
  level?: 'info' | 'success' | 'warning' | 'danger' | string;
  title?: string;
  message?: string;
  read?: boolean;
  ts?: string;
  meta?: Record<string, unknown> | null;
};

export type NotificationsResponse = {
  notifications: SharedNotification[];
  unreadCount: number;
  total: number;
};

const NOTIF_RESOURCE = 'notifications';
const NOTIF_TTL_MS = 4000;

/** The shape the backend pushes on the `notifications` channel. */
type NotificationsDocument = {
  notifications?: any[];
  total?: number;
  unreadCount?: number;
  summary?: Record<string, any>;
  alerts?: Record<string, any>;
  live?: boolean;
};

const fetchFeed = (unreadOnly = false): Promise<NotificationsResponse> =>
  getNotifications(unreadOnly ? '?unread_only=true' : '').then((r) => r as NotificationsResponse);

const fetchAlertSummary = () => getAlertSummary();

/**
 * Shared live feed + unread count for page-header bells and panels.
 *
 * The socket delivers the whole document (feed + counts + alert summary) in
 * one frame; the REST poll below is only the fallback while the socket is
 * down.
 */
export function useNotificationsPoll(options: { pollMs?: number } = {}) {
  const { pollMs = 10000 } = options;
  const { data } = useRealtimeChannel<NotificationsResponse>('notifications', {
    fallbackMs: pollMs,
    fallbackKey: `${NOTIF_RESOURCE}:feed`,
    fallback: () => fetchFeed(),
    select: (doc) => {
      const d = doc as NotificationsDocument;
      return {
        notifications: (d.notifications ?? []) as SharedNotification[],
        unreadCount: Number(d.unreadCount ?? 0),
        total: Number(d.total ?? 0),
      };
    },
  });
  const notifications: SharedNotification[] = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;
  return { notifications, unreadCount, stale: (data?.total ?? -1) < 0 };
}

/**
 * One-shot cached fetch (for pages that don't want continuous polling, e.g.
 * the full notifications page which manages its own refresh after mutations).
 */
export function useNotificationsCache(ttlMs = NOTIF_TTL_MS) {
  const { data, refresh, invalidate } = useCachedResource<NotificationsResponse>(
    NOTIF_RESOURCE,
    () => fetchFeed(),
    { ttlMs },
  );
  const notifications: SharedNotification[] = data?.notifications ?? [];
  const unreadCount = data?.unreadCount ?? 0;
  return { notifications, unreadCount, refresh, invalidate };
}

/** Live unread-only count for a badge.
 *
 * Comes straight from the socket document — no request at all while the
 * socket is healthy.
 */
export function useUnreadCount(pollMs = 10000): number {
  const { data } = useRealtimeChannel<{ unreadCount: number }>('notifications', {
    fallbackMs: pollMs,
    fallbackKey: `${NOTIF_RESOURCE}:unread`,
    fallback: () => fetchFeed(true),
    select: (doc) => ({ unreadCount: Number((doc as NotificationsDocument).unreadCount ?? 0) }),
  });
  return data?.unreadCount ?? 0;
}

export type ActiveAlertsResponse = {
  alerts: any[];
  activeCount: number;
  total: number;
};

/** Live active-alert count for the Alerts bell (socket-first, REST fallback). */
export function useActiveAlertCount(pollMs = 15000): number {
  const { data } = useRealtimeChannel<{ activeCount: number }>('notifications', {
    fallbackMs: pollMs,
    fallbackKey: `${NOTIF_RESOURCE}:alerts`,
    fallback: () =>
      fetchAlertSummary().then((s) => ({
        activeCount: Number(s?.active ?? 0),
      })),
    select: (doc) => {
      const alerts = (doc as NotificationsDocument).alerts ?? {};
      return { activeCount: Number(alerts.active ?? 0) };
    },
  });
  return data?.activeCount ?? 0;
}

/**
 * Severity-aware alert badge for the topbar: real timests never zeros. Tone is
 * driven by real alert severity (critical=red, warning=amber, info=neutral,
 * none=hidden). Socket-first; single shared REST fallback.
 */
export type AlertBadgeTone = 'critical' | 'warning' | 'info' | 'none';

export function useActiveAlertBadge(pollMs = 15000): { count: number; tone: AlertBadgeTone } {
  const { data } = useRealtimeChannel<{
    activeCount: number;
    critical: number;
    warning: number;
  }>('notifications', {
    fallbackMs: pollMs,
    fallbackKey: `${NOTIF_RESOURCE}:alerts`,
    fallback: () =>
      fetchAlertSummary().then((s) => ({
        activeCount: Number(s?.active ?? 0),
        critical: Number(s?.critical ?? 0),
        warning: Number(s?.warning ?? 0),
      })),
    select: (doc) => {
      const alerts = (doc as NotificationsDocument).alerts ?? {};
      return {
        activeCount: Number(alerts.active ?? 0),
        critical: Number(alerts.critical ?? 0),
        warning: Number(alerts.warning ?? 0),
      };
    },
  });

  const count = data?.activeCount ?? 0;
  const critical = data?.critical ?? 0;
  const warning = data?.warning ?? 0;

  let tone: AlertBadgeTone = 'none';
  if (critical > 0) tone = 'critical';
  else if (warning > 0) tone = 'warning';
  else if (count > 0) tone = 'info';
  return { count, tone };
}

// ---- Mutations (all hit the REAL backend; pages call these then refetch) ----

export const notificationActions = {
  markRead: (id: string): Promise<unknown> => markNotificationRead(id),
  markUnread: (id: string): Promise<unknown> => markNotificationUnread(id),
  markAllRead: (): Promise<unknown> => markAllNotificationsRead(),
  delete: (id: string): Promise<unknown> => deleteNotification(id),
  clearAll: (): Promise<unknown> => clearAllNotifications(),
};
