'use client';

// Canonical terminal reconciliation.
//
// The backend SESSION is the authority for which terminal the backend is
// currently establishing data for (session_manager.mode). The frontend
// settings-store also holds a TradingMode. When they diverge — e.g. a persisted
// 'kotak-neo' from an earlier session while the backend session is now 'dummy' —
// the UI would render the wrong (or dummy) terminal. This reconciler adopts the
// BACKEND mode on every hydration/change so the dashboard never shows a
// terminal the backend isn't actually serving.

import { useEffect, useRef } from 'react';
import { useRealtime } from '@/components/realtime-provider';
import { getSettingsStore, fromTerminalId, type TradingMode, type TerminalId } from '@/lib/settings-store';

const VALID: readonly string[] = ['kotak', 'shoonya', 'dummy'];

export function TerminalModeReconciler() {
  const { state, hydrated, sessionActive, appConnection } = useRealtime();
  const appliedRef = useRef<string>('');

  useEffect(() => {
    if (!hydrated) return;
    // state.session?.mode is the live CANONICAL terminal context — the backend
    // now publishes it on every context switch (set_mode), even when the
    // session state string never changes, so it is never stale after a switch.
    // Fall back to state.terminal ONLY when the backend actually holds a live
    // session — an env-default terminal (settings.broker_mode=dummy) with no
    // active backend session must NEVER override the user's explicit choice,
    // which is what caused "Dummy switches back to Kotak".
    const backendMode = state.session?.mode;
    const terminal = state.terminal;
    if (backendMode != null && VALID.includes(String(backendMode))) {
      return adopt(String(backendMode));
    }
    if (sessionActive === true && terminal != null && VALID.includes(String(terminal))) {
      return adopt(String(terminal));
    }
    // No live session while the backend is reachable: Phase-1 terminal is
    // Dummy. A stale local real-broker choice with no session behind it must
    // never keep the error-filled Kotak dashboard open — converge back to
    // Dummy. A real broker comes back via an explicit session switch, which
    // the backend then owns (sessionActive becomes true again above).
    if (appConnection !== 'OFFLINE') {
      const store = getSettingsStore();
      const local: TradingMode = store.getTradingMode();
      if (local !== 'dummy') {
        void store.setMode('dummy');
      }
    }
  }, [hydrated, state.session?.mode, state.terminal, sessionActive, appConnection]);

  function adopt(backendTerminalRaw: string) {
    if (appliedRef.current === backendTerminalRaw) return;
    appliedRef.current = backendTerminalRaw;
    const backendMode = fromTerminalId(backendTerminalRaw as TerminalId);
    const store = getSettingsStore();
    const local: TradingMode = store.getTradingMode();
    if (local !== backendMode) {
      // Adopt the backend's decision locally. setMode persists it so the whole
      // app (switcher, order forms, dashboard) renders the real terminal.
      void store.setMode(backendMode);
    }
  }

  return null;
}