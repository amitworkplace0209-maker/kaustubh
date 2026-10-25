'use client';

// Terminal switch orchestrator.
//
// Switching terminals is a simple context switch. It calls the backend
// /api/terminal/switch (passwordless while Mode Lock is OFF — the default),
// and only reflects the mode locally AFTER the backend switch succeeds.
// No JWT, PIN, or biometric prompt is part of switching; broker
// authentication is handled separately by each terminal's connection UI.

import { useSyncExternalStore } from 'react';
import { switchTerminal } from '@/lib/terminal-service';
import { getSettingsStore, type TradingMode } from '@/lib/settings-store';

export type ModeTransition = 'idle' | 'switching' | 'success' | 'failed';

type TerminalSwitchState = {
  transition: ModeTransition;
  pendingTarget: TradingMode | null;
  error: string | null;
  lastSwitchedTo: TradingMode | null;
};

const INITIAL: TerminalSwitchState = {
  transition: 'idle',
  pendingTarget: null,
  error: null,
  lastSwitchedTo: null,
};

let _state: TerminalSwitchState = INITIAL;
const _listeners = new Set<() => void>();

function setState(patch: Partial<TerminalSwitchState>) {
  _state = { ..._state, ...patch };
  _listeners.forEach((l) => l());
}

function errMessage(err: any): string {
  return (err?.body?.detail?.message ?? err?.rawDetail ?? err?.message ?? 'request failed');
}

export function getTerminalSwitchSnapshot(): TerminalSwitchState {
  return _state;
}

export function subscribeTerminalSwitch(l: () => void): () => void {
  _listeners.add(l);
  return () => _listeners.delete(l);
}

function isBusy() {
  return _state.transition === 'switching';
}

export async function switchTo(target: TradingMode) {
  if (isBusy() || target === getSettingsStore().getTradingMode()) return;
  setState({ transition: 'switching', pendingTarget: target, error: null });
  try {
    await switchTerminal(target);
    await getSettingsStore().setMode(target);
    setState({ transition: 'success', pendingTarget: null, lastSwitchedTo: target });
    window.setTimeout(() => {
      if (_state.transition === 'success') setState({ transition: 'idle' });
    }, 1200);
  } catch (err: any) {
    setState({ transition: 'failed', pendingTarget: null, error: errMessage(err) });
  }
}

export function clearSwitchError() {
  setState({ error: null });
}

export function useTerminalSwitch(): TerminalSwitchState {
  useSyncExternalStore(subscribeTerminalSwitch, getTerminalSwitchSnapshot, () => INITIAL);
  return _state;
}