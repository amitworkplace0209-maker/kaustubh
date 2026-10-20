'use client';

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * OfflineBanner — an honest connectivity indicator.
 *
 * `navigator.onLine` only reports the OS network interface (it still says
 * "online" on a Wi-Fi with no upstream), so the banner is driven by BOTH the
 * browser's online/offline events AND a lightweight reachability probe of the
 * app's own health endpoint. That way a phone that is connected to a router
 * with no internet is reported as offline too.
 *
 * It renders INLINE in the shell column (right under the topbar) — never
 * floating — so it can never overlap the navigation bar or the page content.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = () => {
      if (!navigator.onLine) {
        setOffline(true);
        return;
      }
      // The interface says "online" — verify the app can actually reach the
      // server before we claim the app is online.
      setProbing(true);
      fetch('/api/health', { cache: 'no-store', method: 'GET' })
        .then((res) => setOffline(!res.ok))
        .catch(() => setOffline(true))
        .finally(() => setProbing(false));
    };

    update();
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // Re-check on a slow interval so a dropped upstream is noticed even
    // without an `offline` event.
    const id = setInterval(update, 30_000);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      clearInterval(id);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      data-offline-banner
      className="z-topbar flex shrink-0 items-center justify-center gap-2 border-b border-warning/30 bg-warning/15 px-3 py-1.5 text-[11px] font-semibold text-warning"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {probing ? 'Reconnecting…' : 'Offline — showing the last saved data'}
      </span>
    </div>
  );
}

export default OfflineBanner;
