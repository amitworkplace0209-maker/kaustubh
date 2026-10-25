'use client';

import { useTradingMode } from '@/lib/settings-store';

export function DummyGate({ dummy, standard }: { dummy: React.ReactNode; standard: React.ReactNode }) {
  const mode = useTradingMode();
  return mode === 'dummy' ? dummy : standard;
}