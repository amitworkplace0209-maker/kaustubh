'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * AUTH_EVENT — dispatched after any authentication state transition so the
 * realtime client and other listeners react without page reloads.
 */
export const AUTH_EVENT = 'kaustubh:auth-changed';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailMasked: string;
  hasMpin: boolean;
  mpinUpdatedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthSessionSummary {
  id: string;
  deviceId: string;
  deviceLabel: string;
  ip: string;
  kind: 'primary' | 'secondary';
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AuthState {
  authenticated: boolean;
  checking: boolean;
  hasOwner: boolean;
  needsSignup: boolean;
  needsMpinSetup: boolean;
  needsUnlock: boolean;
  user: AuthUser | null;
  deviceId: string | null;
  sessionId: string | null;
  deviceCount: number;
  maxDevices: number;
  biometricCount: number;
  sessions: AuthSessionSummary[];
  database: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  check: () => Promise<boolean>;
  refresh: () => Promise<AuthState>;
  logout: () => Promise<void>;
}

const INITIAL: AuthState = {
  authenticated: false,
  checking: true,
  hasOwner: false,
  needsSignup: false,
  needsMpinSetup: false,
  needsUnlock: false,
  user: null,
  deviceId: null,
  sessionId: null,
  deviceCount: 0,
  maxDevices: 2,
  biometricCount: 0,
  sessions: [],
  database: true,
  error: null,
};

const AuthContext = createContext<AuthContextValue>({
  ...INITIAL,
  check: async () => false,
  refresh: async () => INITIAL,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function stateFrom(data: Record<string, unknown>): AuthState {
  return {
    authenticated: Boolean(data.authenticated),
    checking: false,
    hasOwner: Boolean(data.hasOwner),
    needsSignup: Boolean(data.needsSignup),
    needsMpinSetup: Boolean(data.needsMpinSetup),
    needsUnlock: Boolean(data.needsUnlock),
    user: (data.user as AuthUser | null) ?? null,
    deviceId: (data.deviceId as string | null) ?? null,
    sessionId: (data.sessionId as string | null) ?? null,
    deviceCount: Number(data.deviceCount ?? 0),
    maxDevices: Number(data.maxDevices ?? 2),
    biometricCount: Number(data.biometricCount ?? 0),
    sessions: (data.sessions as AuthSessionSummary[] | undefined) ?? [],
    database: data.database !== false,
    error: typeof data.message === 'string' ? data.message : null,
  };
}

/**
 * AuthProvider — the single source of truth for the Next-layer app session.
 *
 * It reads `/api/auth/session` once on mount, re-checks on the
 * `kaustubh:auth-changed` event, and refreshes periodically while signed in so
 * the active-device count (1 or 2) stays truthful without a reload.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL);
  const inFlight = useRef<Promise<AuthState> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' });
        const data = (await res.json()) as Record<string, unknown>;
        const next = stateFrom(data);
        setState(next);
        return next;
      } catch {
        const next: AuthState = {
          ...INITIAL,
          checking: false,
          database: false,
          error: 'Could not reach the auth service.',
        };
        setState(next);
        return next;
      }
    })();
    inFlight.current = task;
    try {
      return await task;
    } finally {
      inFlight.current = null;
    }
  }, []);

  const check = useCallback(async () => {
    const next = await refresh();
    return next.authenticated;
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* the cookie is cleared server-side; local state still resets */
    } finally {
      setState({ ...INITIAL, checking: false });
      window.dispatchEvent(new Event(AUTH_EVENT));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onAuthChanged = () => void refresh();
    window.addEventListener(AUTH_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_EVENT, onAuthChanged);
  }, [refresh]);

  useEffect(() => {
    if (!state.authenticated) return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [state.authenticated, refresh]);

  return (
    <AuthContext.Provider value={{ ...state, check, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
