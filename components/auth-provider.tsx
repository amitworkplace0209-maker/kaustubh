'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * AUTH_EVENT — dispatched after any authentication state transition so the
 * realtime client and other listeners react without page reloads.
 */
export const AUTH_EVENT = 'kaustubh:auth-changed';

interface AuthContextValue {
  authenticated: boolean;
  checking: boolean;
  check: () => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  checking: true,
  check: async () => false,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * AuthProvider — the single source of truth for the Next-layer app session.
 *
 * It reads `/api/auth/session` (the `kaustubh_session` cookie) once on mount
 * and re-checks whenever the `kaustubh:auth-changed` event fires (login page
 * dispatches it after a successful login). No reload hacks.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const inFlight = useRef<Promise<boolean> | null>(null);

  const check = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const task = (async () => {
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store' });
        const data = await res.json();
        const ok = Boolean(data?.authenticated);
        setAuthenticated(ok);
        return ok;
      } catch {
        setAuthenticated(false);
        return false;
      } finally {
        setChecking(false);
      }
    })();
    inFlight.current = task;
    try {
      return await task;
    } finally {
      inFlight.current = null;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/login', { method: 'DELETE' });
    } finally {
      setAuthenticated(false);
      setChecking(false);
      window.dispatchEvent(new Event(AUTH_EVENT));
    }
  }, []);

  useEffect(() => {
    void check();
    return undefined;
  }, [check]);

  useEffect(() => {
    const onAuthChanged = () => void check();
    window.addEventListener(AUTH_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_EVENT, onAuthChanged);
  }, [check]);

  return (
    <AuthContext.Provider value={{ authenticated, checking, check, logout }}>
      {children}
    </AuthContext.Provider>
  );
}