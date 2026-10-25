'use client';

// Global TerminalContext — the single source of truth for trading-terminal
// identity (DUMMY | KOTAK NEO | SHOONYA) and the terminal switch orchestration.
//
// Implemented over the existing module singletons (lib/settings-store for the
// durable mode, lib/terminal-mode for the switch state machine) so the context
// is ONLY a provider-shaped view of already-global state: mounting it here at
// the root keeps a single stable identity for the whole app, and switching
// terminals is a plain context switch (no reload, no full-page redirect).
//
// Consumers (sidebar terminal selector, topbar broker controls, mobile drawer)
// use `useTerminal()` instead of reaching into the singletons directly.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTradingMode, type TradingMode } from '@/lib/settings-store';
import {
  clearSwitchError,
  switchTo as switchTerminalMode,
  useTerminalSwitch,
  type ModeTransition,
} from '@/lib/terminal-mode';
import type { LucideIcon } from 'lucide-react';
import { Coins, Landmark, Radar } from 'lucide-react';

export interface TradingTerminalDef {
  id: TradingMode;
  label: string;
  short: string;
  hint: string;
  icon: LucideIcon;
}

/** Canonical display registry for the three trading terminals. */
export const TRADING_TERMINALS: TradingTerminalDef[] = [
  { id: 'kotak-neo', label: 'Kotak Neo', short: 'KOTAK', hint: 'Real Kotak broker account', icon: Landmark },
  { id: 'shoonya', label: 'Shoonya', short: 'SHOONYA', hint: 'Real Shoonya broker · OAuth', icon: Radar },
  { id: 'dummy', label: 'Dummy', short: 'DUMMY', hint: 'Dummy engine — simulated fills', icon: Coins },
];

export const TERMINAL_ACCENT: Record<TradingMode, string> = {
  'kotak-neo': 'bg-success/15 text-success',
  shoonya: 'bg-info/15 text-info',
  dummy: 'bg-purple/15 text-purple',
};

export const TERMINAL_ICON_TONE: Record<TradingMode, string> = {
  'kotak-neo': 'text-success',
  shoonya: 'text-info',
  dummy: 'text-purple',
};

export interface TerminalContextValue {
  /** Canonical active terminal (DUMMY | KOTAK NEO | SHOONYA). */
  mode: TradingMode;
  /** True while a terminal switch request is in flight. */
  busy: boolean;
  /** Overall switch state-machine phase. */
  transition: ModeTransition;
  /** Human-readable error after a failed switch (null = none). */
  error: string | null;
  /** The terminal the last successful switch landed on. */
  lastSwitchedTo: TradingMode | null;
  /** Request a terminal switch (context switch — never reloads the page). */
  switchTo: (target: TradingMode) => Promise<void>;
  /** Clear any pending switch error. */
  clearError: () => void;
  /** Display registry of the switching terminals. */
  terminals: TradingTerminalDef[];
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const mode = useTradingMode();
  const tstate = useTerminalSwitch();

  const value = useMemo<TerminalContextValue>(
    () => ({
      mode,
      busy: tstate.transition === 'switching',
      transition: tstate.transition,
      error: tstate.error,
      lastSwitchedTo: tstate.lastSwitchedTo,
      switchTo: (target: TradingMode) => switchTerminalMode(target),
      clearError: () => clearSwitchError(),
      terminals: TRADING_TERMINALS,
    }),
    [mode, tstate],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const ctx = useContext(TerminalContext);
  if (!ctx) {
    throw new Error('useTerminal must be used within a TerminalProvider');
  }
  return ctx;
}