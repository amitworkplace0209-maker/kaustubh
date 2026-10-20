'use client';

import { useEffect } from 'react';
import { applyPhase2Theme, getPhase2ThemeState } from '@/lib/phase2-theme';

/**
 * ThemeProvider — root-level theme bridge. The theme engine store applies the
 * current app/scope theme to the DOM the moment app or brightness changes; this
 * provider guarantees the correct palette is also applied right after hydration
 * (before any user interaction) so there is no theme flash. No state of its
 * own — global/stable across route navigation.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    applyPhase2Theme(getPhase2ThemeState());
  }, []);
  return <>{children}</>;
}