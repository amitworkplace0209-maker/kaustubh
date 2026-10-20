'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  isPushNotificationSupported,
  subscribeToPushNotifications,
  hasActivePushSubscription,
} from '@/lib/push-notifications';

/**
 * RegisterSW — the PWA bootstrap.
 *
 * Responsibilities:
 *   1. Register (and update) the service worker so the app installs, works
 *      offline and receives Web Push.
 *   2. Surface an "Update available" pill when a new worker is waiting.
 *
 * The install and notification prompts live in `PwaPrompts` — they share ONE
 * fixed slot on a phone and must never be rendered on top of each other.
 *
 * Notification permission is NEVER requested from here: a permission prompt
 * without a user gesture is rejected by Chrome/Edge and permanently poisons
 * the permission state. The in-app prompt owns that flow and is always
 * triggered by a real tap.
 *
 * Service workers are only registered in production builds by default (a
 * cache-first worker from an earlier build can wedge the dev server). Set
 * `NEXT_PUBLIC_PWA_DEV=1` to register it in development as well.
 */
export function RegisterSW() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const isProd = process.env.NODE_ENV === 'production';
    const swEnabledInDev = process.env.NEXT_PUBLIC_PWA_DEV === '1';

    if (!isProd && !swEnabledInDev) {
      // Self-heal: drop ANY stale worker AND its caches, then reload once so a
      // cache-first worker from an earlier build can never keep serving old JS
      // (the "page stuck / nothing shows after an update" symptom). The
      // sessionStorage guard makes the reload happen at most once per session.
      void (async () => {
        try {
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch {
          /* ignore */
        }
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((reg) => reg.unregister()));
        } catch {
          /* ignore */
        }
        try {
          if (navigator.serviceWorker.controller && !sessionStorage.getItem('kaustubh-sw-reset')) {
            sessionStorage.setItem('kaustubh-sw-reset', '1');
            location.reload();
          }
        } catch {
          /* ignore */
        }
      })();
      return;
    }

    let cancelled = false;

    // --- Register the service worker --- -------------------------------
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(async (registration) => {
        if (cancelled) return;

        // A new build is ready — offer the update instead of silently
        // swapping the worker under the user's feet.
        if (registration.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(registration.waiting);
        }
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setWaitingWorker(installing);
            }
          });
        });

        // Wait for the worker to be active before subscribing to push.
        if (!registration.active) {
          await new Promise<void>((resolve) => {
            const onActivate = () => {
              registration.removeEventListener('controllerchange', onActivate);
              resolve();
            };
            registration.addEventListener('controllerchange', onActivate);
            // Never block the boot on the worker.
            setTimeout(resolve, 3000);
          });
        }
        if (cancelled) return;

        // --- Push subscription (no permission prompt here) ------------
        // If permission was already granted (e.g. from Settings), make sure
        // this device is actually subscribed so background pushes arrive.
        if (
          isPushNotificationSupported() &&
          Notification.permission === 'granted' &&
          !hasActivePushSubscription()
        ) {
          await subscribeToPushNotifications(registration);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const applyUpdate = () => {
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
    setWaitingWorker(null);
    // The new worker takes control on the next load; force it so the user
    // sees the update immediately.
    window.location.reload();
  };

  if (!waitingWorker) return null;

  return (
    <div
      // Page level (below the drawer/modal scale) so the update pill can
      // never float on top of an open sidebar.
      className="fixed left-1/2 top-3 z-bottom-nav flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 text-xs font-medium text-foreground shadow-xl backdrop-blur-md"
      role="status"
      data-pwa-update-prompt
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span>Update available</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90"
      >
        Reload
      </button>
    </div>
  );
}
