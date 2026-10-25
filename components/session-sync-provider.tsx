'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useRealtime } from '@/components/realtime-provider';
import { sessionExpiryAnchor } from '@/lib/topbar-status';

export type SessionSyncValue = {
  /** ms remaining on the live backend session; null while not ACTIVE/hydrated. */
  remainingMs: number | null;
  /** Absolute epoch-ms the countdown ticks down to (backend expiresAt). */
  anchorMs: number | null;
  /** True when the backend reports an active authenticated session. */
  active: boolean;
  /** Canonical-looking raw status string from the backend snapshot. */
  status: string;
  /** Backend expiresAt instant (epoch ms) — for popover detail. */
  expiresAtMs: number | null;
  /** Backend login owner — 'MANUAL' | 'SCHEDULER' | null (honest, never guessed). */
  loginSource: string | null;
  /** Backend session id (masked when displayed). */
  sessionId: string | null;
};

const SessionSyncContext = createContext<SessionSyncValue>({
  remainingMs: null,
  anchorMs: null,
  active: false,
  status: 'UNKNOWN',
  expiresAtMs: null,
  loginSource: null,
  sessionId: null,
});

export function useSessionSync() {
  return useContext(SessionSyncContext);
}

/** ISO-8601 string or epoch (sec/ms) → epoch ms. Null when unparseable. */
function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * SessionSyncProvider — the ONE central authenticated-session clock for the
 * whole app, mounted once above every route in AppProviders.
 *
 * Backend-authoritative countdown:
 *   • anchor = real backend `expiresAt` (absolute epoch-ms), so it survives
 *     navigation (provider never remounts) and browser refresh (the realtime
 *     snapshot carries the expiry again).
 *   • A single 1s interval renders `remainingMs`; it floors at 0 and never
 *     goes negative.
 *   • When the backend transitions out of ACTIVE (expiry, auto or manual
 *     logout), the anchor is cleared, the timer stops, and the UI can show
 *     `Login` again. No independent frontend logout/timer lives here.
 *
 * Never fabricated: pre-hydration and non-ACTIVE states yield `null`.
 */
export function SessionSyncProvider({ children }: { children: React.ReactNode }) {
  const rt = useRealtime();
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const sessionRec: Record<string, any> | null = rt.state?.session ?? null;
  const expiresAtMs = useMemo(() => toMs(sessionRec?.expiresAt), [sessionRec?.expiresAt]);
  const loginSource = String(sessionRec?.loginSource ?? '').toUpperCase();
  const sessionId = String(sessionRec?.sessionId ?? '');
  const remainingSeconds =
    typeof sessionRec?.remainingSeconds === 'number' ? sessionRec.remainingSeconds : null;
  const active = rt.sessionActive === true;
  const anchorMs = useMemo(() => sessionExpiryAnchor({
    hydrated: rt.hydrated,
    active: rt.sessionActive,
    expiresAt: expiresAtMs,
    remainingSeconds,
    now: Date.now(),
  }), [rt.hydrated, rt.sessionActive, expiresAtMs, remainingSeconds]);

  // ONE ticking interval, only while a real expiry anchor exists. Cleanup on
  // every anchor change guarantees a single live timer at any moment.
  useEffect(() => {
    if (anchorMs == null) {
      setRemainingMs(null);
      return;
    }
    const refresh = () => setRemainingMs(Math.max(0, anchorMs - Date.now()));
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, [anchorMs]);

  const value = useMemo<SessionSyncValue>(
    () => ({
      remainingMs,
      anchorMs,
      active,
      status: String(sessionRec?.status ?? rt.sessionStatus ?? 'UNKNOWN'),
      expiresAtMs,
      loginSource: loginSource === 'SCHEDULER' ? 'SCHEDULER' : loginSource ? 'MANUAL' : null,
      sessionId: sessionId || null,
    }),
    [remainingMs, anchorMs, active, sessionRec, expiresAtMs, rt.sessionStatus, loginSource, sessionId],
  );

  return <SessionSyncContext.Provider value={value}>{children}</SessionSyncContext.Provider>;
}