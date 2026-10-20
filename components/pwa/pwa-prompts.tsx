'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Download, X } from 'lucide-react';

import {
  hasActivePushSubscription,
  isPushNotificationSupported,
  requestNotificationPermission,
  subscribeToPushNotifications,
} from '@/lib/push-notifications';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALL_DISMISSED_KEY = 'kaustubh_install_dismissed';
const NOTIF_DISMISSED_KEY = 'kaustubh_notif_prompt_dismissed';
/** Only ask for notifications after the app has been used a little — an
 *  immediate prompt on the very first paint is the classic PWA anti-pattern. */
const MIN_VISITS = 2;

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * PwaPrompts — the ONE bottom prompt slot.
 *
 * Two prompts want the same place on a phone: "install the app" and "turn on
 * notifications". Rendering both in the same fixed slot made them overlap
 * (and cover the navigation bar). They now share a single slot and only one
 * is ever visible — the install prompt wins, because installing the app is
 * what enables native notifications in the first place.
 *
 * Both are driven by a REAL user gesture. A permission prompt without one is
 * rejected by Chrome/Edge and can never be shown again.
 */
export function PwaPrompts() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [busy, setBusy] = useState(false);

  // --- Install prompt ---------------------------------------------------
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      try {
        if (sessionStorage.getItem(INSTALL_DISMISSED_KEY) === '1') return;
      } catch {
        /* ignore */
      }
      setInstallEvent(e as BeforeInstallPromptEvent);
      setShowInstall(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // --- Notification permission prompt ------------------------------------
  useEffect(() => {
    if (!isPushNotificationSupported()) return;
    if (Notification.permission !== 'default') return;
    if (hasActivePushSubscription()) return;

    try {
      if (sessionStorage.getItem(NOTIF_DISMISSED_KEY) === '1') return;
    } catch {
      /* ignore */
    }

    let visits = 0;
    try {
      visits = Number(localStorage.getItem('kaustubh_visit_count') || '0') + 1;
      localStorage.setItem('kaustubh_visit_count', String(visits));
    } catch {
      visits = 1;
    }

    // Show it on the second visit, or immediately for an installed app (the
    // user already committed to the app by installing it).
    if (visits >= MIN_VISITS || isStandalone()) {
      const timer = setTimeout(() => setShowNotifications(true), 2500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);

  const dismissInstall = useCallback(() => {
    try {
      sessionStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    setShowInstall(false);
  }, []);

  const dismissNotifications = useCallback(() => {
    try {
      sessionStorage.setItem(NOTIF_DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    setShowNotifications(false);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    await installEvent.userChoice;
    setInstallEvent(null);
    setShowInstall(false);
  }, [installEvent]);

  const handleEnableNotifications = useCallback(async () => {
    setBusy(true);
    try {
      const permission = await requestNotificationPermission();
      if (permission !== 'granted') {
        dismissNotifications();
        return;
      }
      // Subscribe to Web Push so notifications also arrive when the app is
      // closed — this is what makes it behave like a real Android app.
      const registration = await navigator.serviceWorker?.ready;
      if (registration) await subscribeToPushNotifications(registration);
      dismissNotifications();
    } catch {
      dismissNotifications();
    } finally {
      setBusy(false);
    }
  }, [dismissNotifications]);

  // One slot, one prompt.
  if (!showInstall && !showNotifications) return null;

  return (
    <div
      // z-bottom-nav (not a toast level): the prompt belongs to the PAGE, so
      // an open drawer/modal (z-50) must cover it instead of the prompt
      // floating on top of the sidebar.
      className="bottom-nav-offset fixed left-3 right-3 z-bottom-nav flex items-start gap-2.5 rounded-xl border border-border bg-card/95 px-3 py-2.5 text-xs text-foreground shadow-xl backdrop-blur-md md:left-auto md:right-3 md:max-w-sm"
      role="status"
      data-pwa-prompt
    >
      {showInstall ? (
        <>
          <Download className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Install the app</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Run KAUSTUBH full screen, with notifications and offline use.
            </p>
          </div>
          <button
            type="button"
            onClick={handleInstall}
            className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90"
          >
            Install
          </button>
          <button
            type="button"
            onClick={dismissInstall}
            aria-label="Dismiss install prompt"
            className="shrink-0 rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <>
          <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Turn on notifications</p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
              Get order, target and stop-loss alerts even when the app is closed.
            </p>
          </div>
          <button
            type="button"
            onClick={handleEnableNotifications}
            disabled={busy}
            className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? '…' : 'Allow'}
          </button>
          <button
            type="button"
            onClick={dismissNotifications}
            aria-label="Dismiss notification prompt"
            className="shrink-0 rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

export default PwaPrompts;
