'use client';

import { ReactNode } from 'react';
import { useSettings } from '@/lib/settings/store';

/**
 * Mounted ONCE, at the top of the Data Saver `/data-saver/settings/*` layout.
 * Hydrates the single settings store, keeps the refresh timer + cross-tab SSE
 * alive for the settings subtree, and makes the store available to every page.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  useSettings();
  return <>{children}</>;
}