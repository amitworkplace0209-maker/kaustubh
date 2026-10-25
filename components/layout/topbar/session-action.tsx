'use client';

import { useState } from 'react';
import { Loader2, LogIn, LogOut } from 'lucide-react';
import { useRealtime } from '@/components/realtime-provider';
import { useSessionSync } from '@/components/session-sync-provider';
import { useSystem } from '@/components/system-provider';
import { useTradingMode } from '@/lib/settings-store';
import { AUTH_EVENT } from '@/components/auth-provider';
import { getTerminalContext, resolveEffectiveTerminalMode, type TerminalContextConfig } from '@/lib/topbar/context-registry';
import { canonicalSessionState, fmtCountdown, isManualLoginState, systemPollBroker, systemPollSessionActive, type CanonicalSessionState } from '@/lib/topbar-status';
import { cn } from '@/lib/utils';
import { API_BASE as browserApiBase } from '@/lib/api-base';

// Same-origin in the browser: 127.0.0.1 is the DEVICE on a phone, so an
// absolute backend URL can never work there. See lib/api-base.ts.
const API_BASE = browserApiBase;

/**
 * Terminal endpoints must be routed to the BACKEND — the Next origin has no
 * proxy for `/api/auth/*` (matches the `lib/api.ts` convention of calling the
 * Python service on :8000 directly).
 */
function resolveEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http')) return endpoint;
  return `${API_BASE}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
}

export type SessionController = {
  terminal: TerminalContextConfig;
  sessionRec: Record<string, any>;
  sync: ReturnType<typeof useSessionSync>;
  canonical: CanonicalSessionState;
  /** Backend reports a live authenticated session. */
  active: boolean;
  /** Backend genuinely needs a login (INACTIVE/LOGGED_OUT/EXPIRED/ERROR). */
  needsLogin: boolean;
  busy: 'login' | 'logout' | null;
  failed: string | null;
  login: () => void;
  logout: () => void;
};

/**
 * THE one session controller for the topbar.
 *
 * Owns the real login/logout calls (`POST /api/auth/manual-login` and
 * `POST /api/auth/logout` for Kotak, the terminal's own endpoints otherwise)
 * plus their busy/failed state, so the Manual Login button can be rendered in
 * more than one place (the right-hand cluster AND the SESSION indicator's own
 * panel) without ever becoming two different implementations.
 *
 * After a successful login there is NO reload: the backend pushes the new
 * session snapshot over the existing realtime stream and both surfaces
 * re-render from the same central state.
 *
 * Terminal resolution is backend-first (`state.session.mode` → `state.terminal`
 * → the /api/system poll's `enabled_brokers` → local UI mode). DUMMY still
 * never fabricates a session surface: when the BACKEND serves no broker
 * (dummy-only), the controller reports `needsLogin: false` and callers render
 * nothing — but a backend on `kotak`/`shoonya` with no live session DOES get
 * its real Manual Login button even while the local UI mode sits on dummy.
 */
export function useSessionController(): SessionController {
  const rt = useRealtime();
  const sync = useSessionSync();
  const sys = useSystem();
  const tradingMode = useTradingMode();
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const sessionRec = (rt.state?.session ?? {}) as Record<string, any>;
  const canonical = canonicalSessionState(sessionRec.status ?? rt.sessionStatus);
  const active = sync.active && sync.remainingMs != null && sync.remainingMs > 0;

  /*
   * Terminal resolution is BACKEND-first, never UI-mode-first.
   *
   * The reconciler pins the LOCAL mode to `dummy` whenever no live broker
   * session exists — which is precisely when the user needs Manual Login.
   * Reading the terminal from the UI mode alone therefore hid the button at
   * exactly the moment it was needed (backend on `kotak`, session
   * DISCONNECTED, button nowhere). The backend's own `session.mode` /
   * `terminal` win; while the SSE snapshot has not arrived, the existing
   * /api/system poll's `enabled_brokers` decides; the local choice is only the
   * last resort.
   */
  const terminal = getTerminalContext(resolveEffectiveTerminalMode(
    sessionRec.mode,
    (rt.state as Record<string, any> | undefined)?.terminal,
    systemPollBroker(sys.data),
    tradingMode,
  ));

  const run = async (kind: 'login' | 'logout') => {
    if (busy) return;
    setBusy(kind);
    setFailed(null);
    const endpoint = kind === 'login' ? terminal.loginEndpoint : terminal.logoutEndpoint;
    try {
      const res = await fetch(resolveEndpoint(endpoint), { method: 'POST', cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { reason?: string; message?: string } | null;
        setFailed(body?.reason ?? body?.message ?? `${kind} failed (${res.status})`);
      } else {
        // The logout response says "LOGGED_OUT" even when the scheduler owns the
        // session and the call is a no-op, so we only nudge the snapshot — the
        // backend's own state frame is what decides the final UI.
        window.dispatchEvent(new Event(AUTH_EVENT));
        window.dispatchEvent(new Event('kotak-session-changed'));
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : `${kind} failed`);
    } finally {
      setBusy(null);
    }
  };

  /*
   * Login need, realtime first. While the SSE snapshot has not arrived
   * (`hydrated === false` the canonical state is UNKNOWN and says nothing),
   * the existing /api/system poll already carries the scheduler's broker
   * sessions — a served broker with no active session genuinely needs a login,
   * and a live one must NOT be offered a second login. No new network traffic:
   * SystemProvider already polls this every 10s for the whole app.
   */
  const pollNeedsLogin =
    !rt.hydrated && !systemPollSessionActive(sys.data) && systemPollBroker(sys.data) != null;

  return {
    terminal,
    sessionRec,
    sync,
    canonical,
    active,
    needsLogin: terminal.terminal !== 'dummy' && (isManualLoginState(canonical) || pollNeedsLogin),
    busy,
    failed,
    login: () => void run('login'),
    logout: () => void run('logout'),
  };
}

/**
 * The Manual Login action. Rendered in the SESSION indicator's panel (and in
 * the topbar's right cluster) so that a market-closed manual login is always
 * one tap away from the session indicator itself.
 *
 * `variant="pill"` is the compact inline affordance that sits INSIDE the
 * indicator card; `variant="block"` is the full-width button in the panel.
 */
export function ManualLoginButton({
  controller,
  variant = 'block',
  className,
}: {
  controller: SessionController;
  variant?: 'pill' | 'block';
  className?: string;
}) {
  const { terminal, busy, failed, login } = controller;
  const busyLogin = busy === 'login';
  const label = busyLogin ? 'Logging in…' : 'Manual Login';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        login();
      }}
      disabled={busy != null}
      aria-label={`${label} — ${terminal.label}`}
      title={failed ?? `${terminal.label} broker login (works after market close)`}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 rounded-md font-semibold transition-colors disabled:opacity-70',
        variant === 'block'
          ? 'h-9 w-full border border-primary/40 bg-primary/10 px-3 text-xs text-primary hover:bg-primary/20'
          : 'h-6 shrink-0 border border-primary/40 bg-primary/15 px-2 text-[10px] uppercase tracking-wider text-primary hover:bg-primary/25',
        className,
      )}
    >
      {busyLogin ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <LogIn className="size-3.5 shrink-0" aria-hidden />
      )}
      {label}
    </button>
  );
}

/** The logout action shown while a session is genuinely authenticated. */
export function LogoutButton({
  controller,
  className,
}: {
  controller: SessionController;
  className?: string;
}) {
  const { busy, logout } = controller;
  const busyLogout = busy === 'logout';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        logout();
      }}
      disabled={busy != null}
      aria-label="Logout"
      className={cn(
        'inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-70',
        className,
      )}
    >
      {busyLogout ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LogOut className="size-3.5" aria-hidden />}
      {busyLogout ? 'Logging out…' : 'Logout'}
    </button>
  );
}

/**
 * The authenticated-session chip for the topbar's right cluster: the live
 * "how long until this session logs out" countdown, labelled by the backend's
 * real login owner.
 *
 *    [ MANUAL · 59:42 ]          manual session, expires at loginTime + lifetime
 *    [ SCHEDULER LOGIN · 4:32:10 ]  scheduler-owned, counts down to the
 *                                   scheduled logout instant
 *
 * The value comes from the ONE central SessionSyncProvider, which anchors on
 * the backend `expiresAt`, so it survives navigation and browser refresh.
 */
export function SessionCountdownChip({
  controller,
  className,
  onOpen,
}: {
  controller: SessionController;
  className?: string;
  onOpen?: () => void;
}) {
  const { sync, terminal } = controller;
  if (!controller.active || sync.remainingMs == null) return null;

  const source = sync.loginSource === 'SCHEDULER' ? 'SCHEDULER LOGIN' : 'MANUAL';
  const countdown = fmtCountdown(sync.remainingMs);
  const expiring = sync.remainingMs <= 5 * 60_000;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${source} session · ${countdown} remaining · ${terminal.label}`}
      title={`${source} session · auto-logs out in ${countdown}`}
      className={cn(
        'inline-flex h-8 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-md border bg-background/50 px-2 text-[11px] font-semibold transition-colors max-sm:gap-1 max-sm:px-1.5 max-sm:text-[10px] lg:h-9 lg:px-2.5 lg:text-xs',
        expiring ? 'border-warning/40 text-warning hover:bg-warning/10' : 'border-border/70 text-foreground hover:bg-accent',
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', expiring ? 'bg-warning' : 'bg-success')} aria-hidden />
      <span className="tabular-nums">
        <span className="hidden sm:inline">{source} · </span>
        <span className="sm:hidden">{sync.loginSource === 'SCHEDULER' ? 'SCHED' : 'MANUAL'} · </span>
        {countdown}
      </span>
    </button>
  );
}