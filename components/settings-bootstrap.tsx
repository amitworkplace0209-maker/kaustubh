'use client';

import { useEffect } from 'react';
import { getSettingsStore } from '@/lib/settings-store';

/**
 * Loads persisted settings once at application startup so every page
 * renders with saved preferences (account mode, order defaults, ...).
 * Renders children immediately — the load is asynchronous and non-blocking.
 */
export function SettingsBootstrap({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const store = getSettingsStore();
    if (!store.isLoaded()) store.loadFromBackend();
  }, []);

  return <>{children}</>;
}
