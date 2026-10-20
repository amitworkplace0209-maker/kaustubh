'use client';

/**
 * DesktopNotifier — raises real OS/browser notifications for backend events.
 *
 * Mounted once inside the shell so every workspace (Data Saver, Services,
 * Trading, AI) gets the same behaviour from the one system SSE channel.
 *
 * What it listens to, and what it deliberately ignores:
 *   - `notification_created`  -> a genuinely new incident. May raise.
 *   - `notification_updated`  -> a repeat folded into an existing row by the
 *     backend dedupe. NEVER raises. This is the single most important line in
 *     the file: it is what makes a persisting problem show up once instead of
 *     once per poll.
 *   - `alert_created`         -> an alert opened; raises when alerts have desktop
 *     notifications enabled, so an operator sees the red row appear too.
 *
 * Every raise passes through the guard chain in `lib/desktop-notifications`:
 * permission, feature toggle, severity threshold, session tag cooldown, and
 * finally the browser's own native `tag` collapsing.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useRealtime } from '@/components/realtime-provider';
import {
  DEFAULT_MIN_SEVERITY,
  buildPayload,
  claimTag,
  deliverDesktopNotification,
  desktopPermission,
  severityRank,
} from '@/lib/desktop-notifications';

const SETTINGS_POLL_MS = 60_000;

export function DesktopNotifier() {
  const { subscribeToNotificationEvents, hydrated } = useRealtime();

  // Refs, not state: this must never trigger a re-render.
  const notifEnabledRef = useRef(false);
  const alertEnabledRef = useRef(false);
  const minSeverityRef = useRef<string>(DEFAULT_MIN_SEVERITY);

  /**
   * Read the two declared-but-previously-unused switches.
   *
   * `notif_browser` and `alerts_desktop_notifications` both already exist in
   * the backend settings and in the settings UI; nothing consumed them, which
   * is why desktop notifications never fired. Either one being on is enough —
   * an operator who turned on only the alerts toggle still wants to be told.
   */
  const loadSettings = useCallback(async () => {
    try {
      const [n, a] = await Promise.all([
        fetch('/api/notifications/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch('/api/alerts/settings', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      const notif = n?.settings ?? n ?? null;
      const alerts = a?.settings ?? a ?? null;
      if (notif && typeof notif === 'object') {
        notifEnabledRef.current = notif.notif_browser === true;
        if (typeof notif.notif_severity === 'string' && notif.notif_severity) {
          // "all" means no severity gate beyond the enum minimum.
          minSeverityRef.current = notif.notif_severity === 'all' ? 'info' : notif.notif_severity;
        }
      }
      if (alerts && typeof alerts === 'object') {
        alertEnabledRef.current = alerts.alerts_desktop_notifications === true;
      }
    } catch {
      // Settings unavailable — keep whatever we last knew. A failed read must
      // not silently flip notifications off mid-incident.
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void loadSettings();
    const id = setInterval(() => void loadSettings(), SETTINGS_POLL_MS);
    return () => clearInterval(id);
  }, [hydrated, loadSettings]);

  // NOTE: the permission prompt is NOT raised from here. Chrome/Edge reject a
  // `Notification.requestPermission()` that has no user gesture, and a
  // rejected prompt can never be shown again — so asking silently used to
  // leave the user permanently unable to enable notifications. The in-app
  // prompt (`components/pwa/notification-permission-prompt.tsx`) asks from a
  // real tap, and the Settings page keeps an explicit toggle.

  useEffect(() => {
    if (!hydrated) return;

    const raise = async (
      raw: Record<string, unknown>,
      fallbackTitle: string,
      url: string,
    ) => {
      if (desktopPermission() !== 'granted') return;
      if (severityRank(String(raw.severity ?? 'info')) < severityRank(minSeverityRef.current)) return;

      const payload = buildPayload(raw);
      if (!payload.title || payload.title === 'Notification') {
        payload.title = fallbackTitle;
      }
      if (!payload.url) payload.url = url;
      // The claim is what makes this "once": the same incident cannot raise
      // twice in a session even if the frame is delivered again.
      if (!claimTag(payload.tag)) return;
      await deliverDesktopNotification(payload);
    };

    return subscribeToNotificationEvents((frame) => {
      const type = String(frame.type ?? '');
      switch (type) {
        case 'notification_created': {
          const n = (frame.notification as Record<string, unknown> | undefined) ?? null;
          if (!n) return;
          void raise(n, 'Notification', '/data-saver/notifications');
          return;
        }
        case 'alert_created': {
          if (!alertEnabledRef.current) return;
          const a = (frame.alert as Record<string, unknown> | undefined) ?? null;
          if (!a) return;
          // An alert and its notification share the incident, so they must
          // share a tag — otherwise the user gets two popups for one problem.
          const id = String(a._id ?? '');
          void raise(
            {
              ...a,
              deduplication_key: a.deduplication_key ?? `alert:${id}`,
              _id: String(a.related_notification_id ?? ''),
              message: a.message,
            },
            'Alert raised',
            id ? `/data-saver/alerts/${id}` : '/data-saver/alerts',
          );
          return;
        }
        case 'notification_updated':
        case 'alert_updated':
        case 'notification_count_changed':
        case 'alert_count_changed':
          // Counters and folded repeats. Raising here is exactly the
          // "same notification again and again" behaviour being removed.
          return;
        default:
      }
    });
  }, [hydrated, subscribeToNotificationEvents]);

  return null;
}

export default DesktopNotifier;
