'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe `window.matchMedia` subscription.
 *
 * Returns `false` on the server and during the first client render so the markup
 * React hydrates with is identical on both sides; the real value arrives in the
 * effect immediately after mount. Callers must therefore treat the first paint
 * as the CONSERVATIVE value (e.g. render the desktop layout first, then upgrade).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const sync = () => setMatches(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, [query]);

  return matches;
}

/**
 * True when the primary pointer is coarse (finger) — i.e. the PWA / phone case.
 *
 * This is the switch that decides whether the order bar renders the
 * slide-to-confirm gesture or the plain tap button. Desktop keeps the exact
 * behaviour it always had; the touch build gets the one-screen flow.
 */
export function useTouchPointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}