'use client';

import { useEffect, useState } from 'react';

/**
 * A 1 Hz clock that runs ONLY while `active` is true.
 *
 * The four topbar indicators each show a live "in 4h 12m" countdown. Ticking
 * that at the topbar level would re-render the whole bar every second for the
 * entire session, so each indicator subscribes to THIS hook locally and only
 * while the user is actually hovering / has a panel open. When nothing is open
 * the interval does not exist and the bar renders at the backend's own polling
 * cadence.
 *
 * Returns epoch ms, or `null` while inactive so callers fall back to the
 * backend-computed `remaining_seconds` instead of a stale tick.
 */
export function useNowTick(active: boolean, intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      setNow(null);
      return;
    }
    // Seed immediately so a newly opened panel never shows a null frame.
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);

  return now;
}