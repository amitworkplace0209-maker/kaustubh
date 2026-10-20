'use client';

// Shared notifications layer for the whole KAUSTUBH platform.
//
// Single source of truth for unread-count + feed across ALL products
// (Trading, Data Saver, Services, Khumbha AI). It reuses the REAL backend
// notifications API via lib/api.ts and the shared request manager
// (lib/shared-request.ts) so every product shares ONE poll timer per resource
// instead of each page starting its own interval. Never fabricates data.

import { useCachedResource, useSharedPolling } from '@/lib/shared-request';
import {
  getNotifications,
  getAlerts,
  getAlertSummary,
  markNotificationRead,
  markNotificationUnread,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
} from '@/lib/api';
import { useRealtime } from '@/components/realtime-provider';

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

const fetchFeed = (unreadOnly = false): Promise<NotificationsResponse> =>
  getNotifications(unreadOnly ? '?unread_only=true' : '').then((r) => r as NotificationsResponse);

/**
 * Shared live feed + unread count for page-header bells and panels.
 * Uses the shared poll timer so the count is fetched at most once per tick
 * no matter how many components subscribe.
 */
export function useNotificationsPoll(options: { pollMs?: number } = {}) {
  const { pollMs = 10000 } = options;
  const { data } = useSharedPolling<NotificationsResponse>(NOTIF_RESOURCE, fetchFeed, {
    intervalMs: pollMs,
    ttlMs: NOTIF_TTL_MS,
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

/** Live unread-only count for a badge (deduplicated, one shared timer).
 *
 * Realtime-first: the centralized SSE stream (RealtimeProvider) pushes
 * `unreadCount` on every notification frame, so the badge updates instantly.
 * The shared poll timer is only a reconciliation fallback for the times when
 * the realtime channel is NOT hydrated — while live, polling short-circuits to
 * the pushed value and never hits the network.
 */
export function useUnreadCount(pollMs = 10000): number {
  const realtime = useRealtime();
  const { data } = useSharedPolling<NotificationsResponse>(
    `${NOTIF_RESOURCE}:unread`,
    () =>
      realtime.hydrated
        ? Promise.resolve({
            notifications: [],
            unreadCount: realtime.notificationsState.unreadCount,
            total: 0,
          } as NotificationsResponse)
        : fetchFeed(true),
    { intervalMs: pollMs, ttlMs: NOTIF_TTL_MS },
  );
  if (realtime.hydrated && realtime.notificationsState.unreadCount >= 0) {
    return realtime.notificationsState.unreadCount;
  }
  return data?.unreadCount ?? 0;
}

export type ActiveAlertsResponse = {
  alerts: any[];
  activeCount: number;
  total: number;
};

/** Live active-alert count for the Alerts bell (realtime-first, poll fallback). */
export function useActiveAlertCount(pollMs = 15000): number {
  const realtime = useRealtime();
  const { data } = useSharedPolling<ActiveAlertsResponse>(
    'alerts:active',
    () =>
      realtime.hydrated
        ? Promise.resolve({
            alerts: [],
            activeCount: realtime.notificationsState.activeAlerts,
            total: realtime.notificationsState.activeAlerts,
          } as ActiveAlertsResponse)
        // Use the summary endpoint for a count-only query: it returns the real
        // active count without sending an invalid pagination `limit` that the
        // backend rejects (limit must be an integer >= 1).
        : getAlertSummary().then((s) => ({
            alerts: [],
            activeCount: Number(s?.active ?? 0),
            total: Number(s?.total ?? 0),
          })) as unknown as Promise<ActiveAlertsResponse>,
    { intervalMs: pollMs, ttlMs: 6000 },
  );
  const live = realtime.hydrated ? realtime.notificationsState.activeAlerts : data?.activeCount ?? 0;
  return live;
}

/**
 * Severity-aware alert badge for the topbar: real timests never zeros. Tone is
 * driven by real alert severity (critical=red, warning=amber, info=neutral,
 * none=hidden). Realtime-first; single shared poll fallback.
 */
export type AlertBadgeTone = 'critical' | 'warning' | 'info' | 'none';

export function useActiveAlertBadge(pollMs = 15000): { count: number; tone: AlertBadgeTone } {
  const realtime = useRealtime();
  const { data } = useSharedPolling<{ activeCount: number; critical: number; warning: number }>(
    'alerts:badge',
    () =>
      realtime.hydrated
        ? Promise.resolve({
            activeCount: realtime.notificationsState.activeAlerts,
            critical: 0,
            warning: 0,
          })
        : getAlertSummary().then((s) => ({
            activeCount: Number(s?.active ?? 0),
            critical: Number(s?.critical ?? 0),
            warning: Number(s?.warning ?? 0),
          })),
    { intervalMs: pollMs, ttlMs: 6000 },
  );

  const liveCount = realtime.hydrated ? realtime.notificationsState.activeAlerts : data?.activeCount ?? 0;
  const liveAlerts = realtime.hydrated ? realtime.notificationsState.latestAlerts : [];
  const hasCritical = liveAlerts.some((a) => a.severity === 'critical');
  const hasWarning = !hasCritical && liveAlerts.some((a) => a.severity === 'warning');

  let tone: AlertBadgeTone = 'none';
  if (realtime.hydrated) {
    if (hasCritical || liveCount > 0) tone = hasCritical ? 'critical' : liveCount > 0 ? 'info' : 'none';
    if (hasWarning) tone = 'warning';
  } else {
    if ((data?.critical ?? 0) > 0) tone = 'critical';
    else if ((data?.warning ?? 0) > 0) tone = 'warning';
    else if (liveCount > 0) tone = 'info';
  }
  return { count: liveCount, tone };
}

// ---- Mutations (all hit the REAL backend; pages call these then refetch) ----

export const notificationActions = {
  markRead: (id: string): Promise<unknown> => markNotificationRead(id),
  markUnread: (id: string): Promise<unknown> => markNotificationUnread(id),
  markAllRead: (): Promise<unknown> => markAllNotificationsRead(),
  delete: (id: string): Promise<unknown> => deleteNotification(id),
  clearAll: (): Promise<unknown> => clearAllNotifications(),
};
